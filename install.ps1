[CmdletBinding()]
param(
    [string]$ShadowBotDirectory,
    [ValidateSet('pi', 'opencode-origin')][string]$Harness
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/activation.ps1')
. (Join-Path $PSScriptRoot 'scripts/discovery.ps1')
. (Join-Path $PSScriptRoot 'scripts/toolchain.ps1')

$project = $PSScriptRoot
$state = Join-Path $project '.shadowbot-switch'
$local = [Environment]::GetFolderPath('LocalApplicationData')
$legacy = Join-Path $local 'ShadowBotPi'
$manifest = Join-Path $state 'install.json'
$mode = Join-Path $state 'backend.json'
$original = Join-Path $state 'original/opencode.exe'
$supportedVersion = '6.3.39'
$pinnedHash = 'DE2E62AB0E3F27A3EA7FF9EF4C4FE7097F0D6DF01118B2E7C5F57726256D6314'

if (!$Harness) {
    Write-Host '1. pi'
    Write-Host '2. opencode-origin (restore the bundled OpenCode)'
    $Harness = switch (Read-Host 'Select a harness') {
        { $_ -in '1', 'pi' } { 'pi'; break }
        { $_ -in '2', 'opencode-origin' } { 'opencode-origin'; break }
        default { throw 'Select pi or opencode-origin.' }
    }
}
if (!$ShadowBotDirectory) { $ShadowBotDirectory = Find-ShadowBotDirectory $manifest }
if (!$ShadowBotDirectory) { $ShadowBotDirectory = Read-Host 'ShadowBot installation directory' }
if (!$ShadowBotDirectory) { throw 'A ShadowBot installation directory is required.' }

$shadowBot = (Resolve-Path -LiteralPath $ShadowBotDirectory).Path
$hostExe = Join-Path $shadowBot 'ShadowBot.exe'
$versionedDirectory = Join-Path $shadowBot "shadowbot-$supportedVersion"
$agentExe = Join-Path $versionedDirectory 'opencode.exe'
$locator = "$agentExe.shadowbot-pi.json"
$resources = Join-Path $versionedDirectory 'Resources'
$database = Join-Path $local 'ShadowBot/opencode/runtime/shared/xdg_data/opencode/opencode.db'
$hostSkills = Join-Path $local 'ShadowBot/opencode/runtime/shared/skills'
$users = Join-Path $local 'ShadowBot/users'

function Assert-HostStopped {
    $browserBridge = Join-Path $local 'ShadowBot/support_X64/Chrome/ShadowBot.ChromeBridge.exe'
    $running = Get-Process -Name 'ShadowBot*', 'opencode' -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -ne 'shadowbot-pi' -and ($_.ProcessName -ne 'ShadowBot.ChromeBridge' -or $_.Path -ne $browserBridge)
    }
    if ($running) { throw 'Exit ShadowBot and OpenCode before switching harnesses.' }
}

function Read-Installation($StateDirectory) {
    $path = Join-Path $StateDirectory 'install.json'
    if (!(Test-Path -LiteralPath $path)) { return $null }
    $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($existing.agentPath -ne $agentExe -or $existing.originalHash -ne $pinnedHash -or
        $existing.database -ne $database -or $existing.users -ne $users) {
        throw 'The existing manifest belongs to another ShadowBot installation.'
    }
    $existing
}

function Remove-ProjectStage($Path) {
    if (!(Test-Path -LiteralPath $Path)) { return }
    $target = (Resolve-Path -LiteralPath $Path).Path
    if ($target -ne $Path -or !$target.StartsWith("$state\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unexpected installation staging directory.'
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}

function Install-PiHarness($Toolchain) {
    $path = Join-Path $state 'harnesses/pi'
    $package = 'node_modules/@earendil-works/pi-coding-agent/package.json'
    if (Test-Path -LiteralPath (Join-Path $path $package)) {
        return (Get-Content -LiteralPath (Join-Path $path $package) -Raw | ConvertFrom-Json).version
    }
    $lock = Join-Path $path 'package-lock.json'
    if (Test-Path -LiteralPath $lock) {
        Invoke-ProjectNpm $Toolchain $path @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') | Out-Host
        return (Get-Content -LiteralPath (Join-Path $path $package) -Raw | ConvertFrom-Json).version
    }

    $stage = "$path.$PID.tmp"
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        $published = Invoke-ProjectNpm $Toolchain $stage @('view', '@earendil-works/pi-coding-agent@latest', 'version', 'dependencies', '--json') |
            Out-String | ConvertFrom-Json
        if (!$published.version -or !$published.dependencies.'@earendil-works/pi-ai' -or !$published.dependencies.'@earendil-works/pi-mcp') {
            throw 'The published Pi harness has an unexpected dependency manifest.'
        }
        Write-AtomicJson (Join-Path $stage 'package.json') @{ private = $true; dependencies = @{
            '@earendil-works/pi-coding-agent' = $published.version
            '@earendil-works/pi-ai' = $published.dependencies.'@earendil-works/pi-ai'
            '@earendil-works/pi-mcp' = $published.dependencies.'@earendil-works/pi-mcp'
            'yaml' = '2.9.0'
        } }
        Invoke-ProjectNpm $Toolchain $stage @('install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') | Out-Host
        $installed = (Get-Content -LiteralPath (Join-Path $stage $package) -Raw | ConvertFrom-Json).version
        if ($installed -ne $published.version) { throw 'Installed Pi version does not match the registry.' }
        [IO.Directory]::Move($stage, $path)
        Write-Host "Installed Pi $installed in $path"
        return $installed
    } finally {
        Remove-ProjectStage $stage
    }
}

function New-RuntimeRelease($Toolchain, $PiVersion) {
    $skillSources = Join-Path $project 'skills'
    $inputs = @((Get-ChildItem -File -Recurse -LiteralPath @(
        (Join-Path $project 'launcher'), (Join-Path $project 'src'), $skillSources
    )).FullName)
    $inputs += @('package.json', 'package-lock.json', 'go.mod', 'go.sum', 'tsconfig.json', 'contract/schema.sql', 'scripts/toolchain.ps1',
        '.shadowbot-switch/harnesses/pi/package-lock.json' | ForEach-Object { Join-Path $project $_ })
    $fingerprint = @($Toolchain.nodeHash, $PiVersion) + @(foreach ($path in ($inputs | Sort-Object)) {
        "$path $((Get-FileHash -LiteralPath $path).Hash)"
    })
    $id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($fingerprint -join "`n")))).ToLowerInvariant()
    $release = Get-ReleasePath $state $id $PiVersion
    if (!(Test-Path -LiteralPath $release)) {
        Build-Bridge $project $Toolchain -SkipTests
        $stage = "$release.$PID.tmp"
        $service = Join-Path $stage 'service'
        New-Item -ItemType Directory -Force -Path $service, (Join-Path $stage 'skills') | Out-Null
        try {
            Copy-Item -LiteralPath (Join-Path $project 'dist/opencode.exe') -Destination (Join-Path $stage 'launcher.exe')
            Copy-Item -LiteralPath $Toolchain.node -Destination (Join-Path $stage 'node.exe')
            Copy-Item -LiteralPath (Join-Path $project 'contract/schema.sql') -Destination $stage
            Write-AtomicJson (Join-Path $stage 'package.json') @{ type = 'module' }
            Get-ChildItem -LiteralPath (Join-Path $project 'dist/service') -File -Filter '*.js' | Copy-Item -Destination $service
            Get-ChildItem -LiteralPath $skillSources -Directory | Copy-Item -Destination (Join-Path $stage 'skills') -Recurse
            [IO.Directory]::Move($stage, $release)
        } finally {
            Remove-ProjectStage $stage
        }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $release 'node.exe')).Hash -ne $Toolchain.nodeHash) { throw 'Runtime Node checksum mismatch.' }
    @{
        agentPath = $agentExe; originalHash = $pinnedHash; launcherHash = (Get-FileHash -LiteralPath (Join-Path $release 'launcher.exe')).Hash
        runtimeRelease = $id; piVersion = $PiVersion; database = $database; users = $users; resources = $resources; hostSkills = $hostSkills
    }
}

function Invoke-RuntimeControl($StateDirectory, $Install, [string[]]$Arguments) {
    $runtime = if ($Install.runtimeRelease) { Get-ReleasePath $StateDirectory $Install.runtimeRelease $Install.piVersion } else { $StateDirectory }
    $previousHome = $env:SHADOWBOT_PI_HOME
    $previousPi = $env:PI_CODING_AGENT_DIR
    try {
        $env:SHADOWBOT_PI_HOME = $StateDirectory
        $env:PI_CODING_AGENT_DIR = Join-Path $StateDirectory 'agent'
        & (Join-Path $runtime 'node.exe') (Join-Path $runtime 'service/control.js') @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Harness operation failed: $($Arguments -join ' ')" }
    } finally {
        $env:SHADOWBOT_PI_HOME = $previousHome
        $env:PI_CODING_AGENT_DIR = $previousPi
    }
}

function Copy-LegacyState {
    Assert-HostStopped
    $legacyOriginal = Join-Path $legacy 'original/opencode.exe'
    if ((Get-FileHash -LiteralPath $legacyOriginal).Hash -ne $pinnedHash) { throw 'Legacy original backup checksum mismatch.' }
    $legacyMode = (Get-Content -LiteralPath (Join-Path $legacy 'backend.json') -Raw | ConvertFrom-Json).mode
    if ($legacyMode -notin 'original', 'observe', 'pi') { throw 'Invalid legacy backend mode.' }
    if ($legacyMode -eq 'observe') { $legacyMode = 'original' }

    New-Item -ItemType Directory -Force -Path (Split-Path $original), (Join-Path $state 'agent') | Out-Null
    Set-CheckedExecutable $legacyOriginal $original $pinnedHash
    $legacyBackends = Join-Path $legacy 'backends'
    if (Test-Path -LiteralPath $legacyBackends) { Copy-Item -LiteralPath $legacyBackends -Destination $state -Recurse -Force }
    $legacyAgent = Join-Path $legacy 'agent'
    if (Test-Path -LiteralPath $legacyAgent) {
        foreach ($file in (Get-ChildItem -LiteralPath $legacyAgent -Recurse -File -Force)) {
            $relative = [IO.Path]::GetRelativePath($legacyAgent, $file.FullName)
            $destination = Join-Path $state "agent/$relative"
            if (!(Test-Path -LiteralPath $destination)) {
                New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
                Copy-Item -LiteralPath $file.FullName -Destination $destination
            }
        }
    }
    Write-AtomicJson $mode @{ mode = $legacyMode }
}

if ((Get-Item -LiteralPath $hostExe).VersionInfo.ProductVersion -ne $supportedVersion) {
    throw "Unsupported ShadowBot version. Expected $supportedVersion."
}

Invoke-InstallationLock $agentExe {
    Assert-HostStopped
    Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    $projectInstall = Read-Installation $state
    $activeHash = (Get-FileHash -LiteralPath $agentExe).Hash
    $activeHome = $null
    $activeInstall = $null
    if ($activeHash -ne $pinnedHash) {
        if (!(Test-Path -LiteralPath $locator)) { throw 'Active OpenCode is neither the bundled binary nor a recognized launcher.' }
        $activeHome = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
        if ($activeHome -notin $state, $legacy) { throw 'This ShadowBot installation is managed by a different project directory.' }
        Complete-Activation $activeHome $agentExe $pinnedHash ${function:Assert-HostStopped}
        $activeHash = (Get-FileHash -LiteralPath $agentExe).Hash
        $activeInstall = Read-Installation $activeHome
        if ($activeHash -ne $activeInstall.launcherHash) { throw 'Active launcher checksum mismatch.' }
    }

    $migrateLegacy = $activeHome -eq $legacy
    if (!$activeHome -and !(Test-Path -LiteralPath $mode) -and (Read-Installation $legacy)) {
        $legacyMode = (Get-Content -LiteralPath (Join-Path $legacy 'backend.json') -Raw | ConvertFrom-Json).mode
        if ($legacyMode -eq 'pi' -or (Test-Path -LiteralPath (Join-Path $legacy 'switch.pending.json'))) {
            throw 'The legacy state does not match the bundled OpenCode. Recover the legacy installation first.'
        }
        $migrateLegacy = $true
    }
    if (!$activeHome -and (Test-Path -LiteralPath $mode) -and
        ((Get-Content -LiteralPath $mode -Raw | ConvertFrom-Json).mode -eq 'pi' -or
            (Test-Path -LiteralPath (Join-Path $state 'switch.pending.json')))) {
        throw 'The project session state does not match the bundled OpenCode.'
    }

    if ($Harness -eq 'opencode-origin') {
        if ($activeInstall) {
            Invoke-RuntimeControl $activeHome $activeInstall @('backend', 'original') | Out-Host
        }
        if ($migrateLegacy) { Copy-LegacyState }
        if ($activeInstall) {
            Set-CheckedExecutable $original $agentExe $pinnedHash $activeHash ${function:Assert-HostStopped}
        }
        if (Test-Path -LiteralPath $locator) {
            $owner = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
            if ($owner -in $state, $legacy) { Remove-Item -LiteralPath $locator -Force }
        }
        Write-Output 'Active harness: opencode-origin (bundled OpenCode 1.18.12)'
        return
    }

    if (!(Test-Path -LiteralPath $database)) { throw 'Open ShadowBot Copilot once to initialize its session database, then exit ShadowBot.' }
    if ($activeHome -and (Test-Path -LiteralPath (Join-Path $activeHome 'switch.pending.json'))) {
        $current = (Get-Content -LiteralPath (Join-Path $activeHome 'backend.json') -Raw | ConvertFrom-Json).mode
        $recovery = if ($current -eq 'pi') { 'pi' } else { 'original' }
        Invoke-RuntimeControl $activeHome $activeInstall @('backend', $recovery) | Out-Host
    }
    $toolchain = Initialize-Toolchain $project
    $piVersion = Install-PiHarness $toolchain
    $release = New-RuntimeRelease $toolchain $piVersion
    Assert-HostStopped
    if ($migrateLegacy) { Copy-LegacyState }
    if (!(Test-Path -LiteralPath $original)) {
        if ($activeHash -ne $pinnedHash) { throw 'Original OpenCode backup is missing.' }
        New-Item -ItemType Directory -Force -Path (Split-Path $original) | Out-Null
        Set-CheckedExecutable $agentExe $original $pinnedHash
    }
    if (!(Test-Path -LiteralPath $mode)) { Write-AtomicJson $mode @{ mode = 'original' } }
    New-Item -ItemType Directory -Force -Path (Join-Path $state 'agent') | Out-Null
    $runtime = Get-ReleasePath $state $release.runtimeRelease $release.piVersion
    if ((& (Join-Path $runtime 'launcher.exe') --version | Out-String).Trim() -ne '1.18.12') { throw 'Launcher protocol mismatch.' }
    Write-AtomicJson (Join-Path $state 'prepared.json') $release
    Invoke-RuntimeControl $state $release @('verify-install') | Out-Host
    Assert-HostStopped
    if ($activeHome -ne $state -or $activeHash -ne $release.launcherHash -or $projectInstall.runtimeRelease -ne $release.runtimeRelease) {
        Write-AtomicJson (Join-Path $state 'activation.pending.json') @{ previousHash = $activeHash; release = $release }
        Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    }
    Invoke-RuntimeControl $state $release @('backend', 'pi') | Out-Host
    Write-Output "Active harness: pi ($piVersion)"
    Write-Output "Project state: $state"
}
