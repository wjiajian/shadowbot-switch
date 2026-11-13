$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot
. (Join-Path $repository 'scripts/activation.ps1')
. (Join-Path $repository 'scripts/runtime.ps1')
$base = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
$root = Join-Path $base "shadowbot-harness-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $project = Join-Path $root 'project'
    $state = Join-Path $project '.shadowbot-switch'
    New-Item -ItemType Directory -Force -Path $state, (Join-Path $project 'scripts'), (Join-Path $project 'launcher'), (Join-Path $project 'src'), (Join-Path $project 'skills'), (Join-Path $project 'contract') | Out-Null
    Copy-Item -LiteralPath (Join-Path $repository 'harnesses') -Destination $project -Recurse
    $fixture = Join-Path $project 'harnesses/fixture'
    New-Item -ItemType Directory -Path $fixture | Out-Null
    Copy-Item -LiteralPath (Join-Path $repository 'test/fixtures/harness/harness.json') -Destination $fixture
    Copy-Item -LiteralPath (Join-Path $repository 'switch.ps1') -Destination $project
    Copy-Item -LiteralPath (Join-Path $repository 'scripts/harnesses.ps1') -Destination (Join-Path $project 'scripts')
    Copy-Item -LiteralPath (Join-Path $repository 'scripts/toolchain.ps1') -Destination (Join-Path $project 'scripts')
    foreach ($name in @('go.mod', 'go.sum', 'tsconfig.json', 'contract/schema.sql')) { Copy-Item -LiteralPath (Join-Path $repository $name) -Destination (Join-Path $project $name) }
    Write-AtomicJson (Join-Path $project 'package.json') @{ name = 'harness-test'; version = '1.0.0'; type = 'module' }
    Write-AtomicJson (Join-Path $project 'package-lock.json') @{ name = 'harness-test'; version = '1.0.0'; lockfileVersion = 3; packages = @{ '' = @{ name = 'harness-test'; version = '1.0.0' } } }
    @'
param([string]$Harness, [switch]$Update, [switch]$Wait, [int]$WaitTimeoutSeconds, [string]$ShadowBotDirectory)
@{ harness = $Harness; update = [bool]$Update } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'selection.json')
'@ | Set-Content -LiteralPath (Join-Path $project 'install.ps1')
    $spec = Get-Harness $project 'test-engine'
    if ($spec.id -ne 'fixture') { throw 'Registry alias failed.' }
    Write-AtomicJson (Join-Path $state 'backend.json') @{ mode = 'fixture' }
    & (Join-Path $project 'switch.ps1') update
    $selection = Get-Content -LiteralPath (Join-Path $project 'selection.json') -Raw | ConvertFrom-Json
    if ($selection.harness -ne 'fixture' -or !$selection.update) { throw 'Default update did not select the active harness.' }
    & (Join-Path $project 'switch.ps1') update pi
    $selection = Get-Content -LiteralPath (Join-Path $project 'selection.json') -Raw | ConvertFrom-Json
    if ($selection.harness -ne 'pi' -or (Get-SelectedHarness $state) -ne 'fixture') { throw 'Explicit update changed selection.' }
    & (Join-Path $project 'switch.ps1') use test-engine
    if ((Get-Content -LiteralPath (Join-Path $project 'selection.json') -Raw | ConvertFrom-Json).harness -ne 'fixture') { throw 'use did not dispatch the registered harness.' }

    # Exercise the real immutable release packager and activation with offline build/npm providers.
    function Build-Bridge($Project, $Toolchain, [switch]$SkipTests) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Project 'dist/service/adapters/fixture') | Out-Null
        Set-Content -LiteralPath (Join-Path $Project 'dist/opencode.exe') -Value 'generic fixture launcher'
        Set-Content -LiteralPath (Join-Path $Project 'dist/service/adapters/fixture/index.js') -Value 'export const adapter = { id: "fixture" };'
    }
    function Invoke-ProjectNpm($Toolchain, $Prefix, [string[]]$Arguments) {
        if ($Arguments[0] -ne 'ci' -or $Arguments -notcontains '--omit=dev') { throw 'Runtime dependencies must use the lockfile without dev dependencies.' }
    }
    $node = Join-Path $repository '.tools/node/node.exe'
    $toolchain = @{ node = $node; nodeHash = (Get-FileHash -LiteralPath $node).Hash }
    $agent = Join-Path $root 'opencode.exe'
    Set-Content -LiteralPath $agent -Value 'bundled fixture'
    $originalHash = (Get-FileHash -LiteralPath $agent).Hash
    $hostInstallation = @{ agentPath = $agent; originalHash = $originalHash; database = 'fixture.db'; users = 'users'; resources = 'resources' }
    $first = New-RuntimeRelease $project $state $toolchain $spec $null $hostInstallation
    if ($first.harnesses.fixture.version -ne '1.0.0' -or $first.piVersion) { throw 'Release metadata is not harness-neutral.' }
    $runtime = Get-InstallationRuntime $state $first 'fixture'
    if (!(Test-Path -LiteralPath (Join-Path $runtime 'service/adapters/fixture/index.js'))) { throw 'Nested adapter was not packaged.' }
    Write-AtomicJson (Join-Path $state 'activation.pending.json') @{ previousHash = $originalHash; release = $first }
    Complete-Activation $state $agent $originalHash {}
    if ((Get-Content -LiteralPath (Join-Path $state 'install.json') -Raw | ConvertFrom-Json).runtime.harness -ne 'fixture') { throw 'Generic activation failed.' }
    $first.harnesses['existing'] = @{ release = 'a' * 64; version = '9.0' }
    Set-Content -LiteralPath (Join-Path $project 'src/change.ts') -Value '// new source version'
    $second = New-RuntimeRelease $project $state $toolchain $spec $first $hostInstallation
    if ($second.runtime.release -eq $first.runtime.release -or !$second.harnesses.existing) { throw 'Update failed to retain other harness releases.' }
    if ((Get-Content -LiteralPath (Join-Path $state 'install.json') -Raw | ConvertFrom-Json).runtime.release -ne $first.runtime.release) { throw 'Preparation changed the committed runtime.' }
    Write-AtomicJson (Join-Path $state 'activation.pending.json') @{ previousHash = $first.launcherHash; release = $second }
    Complete-Activation $state $agent $originalHash {}
    if ((Get-SelectedHarness $state) -ne 'fixture') { throw 'Updating a runtime changed harness selection.' }
    Write-Output 'Registry-driven selection, immutable packaging, multi-harness metadata and activation passed.'
} finally {
    $resolved = (Resolve-Path -LiteralPath $root).Path
    if ((Split-Path $resolved) -ne $base -or !$resolved.StartsWith((Join-Path $base 'shadowbot-harness-'))) { throw 'Unexpected test path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
