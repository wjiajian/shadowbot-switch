$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot
. (Join-Path $project 'scripts/activation.ps1')
. (Join-Path $project 'scripts/maintenance.ps1')
$base = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
$root = Join-Path $base "shadowbot-experience-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $state = Join-Path $root 'state'
    $id = 'a' * 64
    $runtime = Get-ReleasePath $state $id 'fixture'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $launcher = Join-Path $runtime 'launcher.exe'
    Set-Content -LiteralPath $launcher -Value 'fixture launcher'

    $original = Join-Path $state 'original/opencode.exe'
    New-Item -ItemType Directory -Path (Split-Path $original) | Out-Null
    Set-Content -LiteralPath $original -Value 'fixture original'
    $hash = (Get-FileHash -LiteralPath $original).Hash
    $agent = Join-Path $root 'opencode.exe'
    Copy-Item -LiteralPath $launcher -Destination $agent
    $installation = @{ agentPath = $agent; originalHash = $hash; launcherHash = (Get-FileHash -LiteralPath $launcher).Hash; runtimeRelease = $id; piVersion = 'fixture' }
    Write-AtomicJson (Join-Path $state 'install.json') $installation
    Write-AtomicJson "$agent.shadowbot-pi.json" @{ home = (Join-Path $root 'old-missing-state') }
    Repair-InstallationLocator $state $hash {}
    if ((Get-Content -LiteralPath "$agent.shadowbot-pi.json" -Raw | ConvertFrom-Json).home -ne $state) { throw 'Moved project locator was not repaired.' }
    if ((Get-FileHash -LiteralPath (Join-Path $state 'shadowbot-pi.exe')).Hash -ne $installation.launcherHash) { throw 'Management launcher was not restored.' }
    $other = Join-Path $root 'other-existing-project'
    New-Item -ItemType Directory -Path $other | Out-Null
    Write-AtomicJson "$agent.shadowbot-pi.json" @{ home = $other }
    $rejected = $false
    try { Repair-InstallationLocator $state $hash {} } catch { $rejected = $true }
    if (!$rejected) { throw 'An existing project was taken over.' }

    # Deterministic process snapshots exercise the actual waiting code, without touching live processes.
    $script:processChecks = 0
    function Get-SwitchProcesses { $script:processChecks++; if ($script:processChecks -lt 3) { [pscustomobject]@{ Id = 123; ProcessName = 'fixture'; Path = 'fixture.exe' } } }
    Wait-SwitchProcesses -Wait -TimeoutSeconds 3
    if ($script:processChecks -lt 3) { throw 'Process wait did not recheck.' }
    function Get-SwitchProcesses { [pscustomobject]@{ Id = 123; ProcessName = 'fixture'; Path = 'fixture.exe' } }
    $rejected = $false
    try { Wait-SwitchProcesses } catch { $rejected = $true }
    if (!$rejected) { throw 'Busy switching proceeded without waiting.' }
    Write-Output 'Relocation repair and process waiting passed.'
} finally {
    $resolved = (Resolve-Path -LiteralPath $root).Path
    if ((Split-Path $resolved) -ne $base -or !$resolved.StartsWith((Join-Path $base 'shadowbot-experience-'))) { throw 'Unexpected test path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
