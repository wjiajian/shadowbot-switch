$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot) 'scripts/activation.ps1')

$base = [IO.Path]::TrimEndingDirectorySeparator((Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path)
$root = Join-Path $base "shadowbot-pi-install-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $state = Join-Path $root 'state'
    $agent = Join-Path $root 'opencode.exe'
    $control = Join-Path $state 'shadowbot-pi.exe'
    $manifest = Join-Path $state 'install.json'
    $pending = Join-Path $state 'activation.pending.json'
    $oldID = 'a' * 64
    $newID = 'b' * 64
    $oldRuntime = Get-ReleasePath $state $oldID
    $newRuntime = Get-ReleasePath $state $newID '1.5.2'
    New-Item -ItemType Directory -Path $oldRuntime, $newRuntime -Force | Out-Null
    Set-Content -LiteralPath $agent -Value 'Original OpenCode fixture'
    $originalHash = (Get-FileHash -LiteralPath $agent).Hash
    $backup = Join-Path $state 'opencode.original.exe'
    Set-CheckedExecutable $agent $backup $originalHash
    Set-Content -LiteralPath (Join-Path $oldRuntime 'launcher.exe') -Value 'Previous launcher fixture'
    Set-Content -LiteralPath (Join-Path $newRuntime 'launcher.exe') -Value 'Updated launcher fixture'
    $oldRelease = @{ agentPath = $agent; originalHash = $originalHash; launcherHash = (Get-FileHash (Join-Path $oldRuntime 'launcher.exe')).Hash; runtimeRelease = $oldID }
    $newRelease = @{ agentPath = $agent; originalHash = $originalHash; launcherHash = (Get-FileHash (Join-Path $newRuntime 'launcher.exe')).Hash; runtimeRelease = $newID; piVersion = '1.5.2' }

    Write-AtomicJson $pending @{ previousHash = $originalHash; release = $oldRelease }
    Complete-Activation $state $agent $originalHash {}
    if ((Get-FileHash -LiteralPath $agent).Hash -ne $oldRelease.launcherHash) { throw 'Initial activation did not replace the agent.' }
    if ((Get-Content -LiteralPath "$agent.shadowbot-pi.json" -Raw | ConvertFrom-Json).home -ne $state) { throw 'Launcher location was not published.' }
    if ((Get-FileHash -LiteralPath $control).Hash -ne $oldRelease.launcherHash) { throw 'Control launcher was not published.' }
    if (Test-Path -LiteralPath $pending) { throw 'Initial activation journal was not cleared.' }

    Write-AtomicJson (Join-Path $state 'prepared.json') $newRelease
    if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $oldID) { throw 'Staging changed the active release.' }
    Write-AtomicJson $pending @{ previousHash = $oldRelease.launcherHash; release = $newRelease }
    $lock = [IO.File]::Open($control, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $interrupted = $false
        try { Complete-Activation $state $agent $originalHash {} }
        catch { $interrupted = $true }
        if (!$interrupted) { throw 'Expected the locked control executable to interrupt activation.' }
        if ((Get-FileHash -LiteralPath $agent).Hash -ne $newRelease.launcherHash) { throw 'Fixture did not interrupt activation after replacing the agent.' }
        if (!(Test-Path -LiteralPath $pending)) { throw 'Interrupted activation lost its recovery journal.' }
        if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $oldID) { throw 'Interrupted activation committed the manifest too early.' }
    } finally { $lock.Dispose() }

    Complete-Activation $state $agent $originalHash {}
    if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $newID) { throw 'Recovery did not publish the prepared release.' }
    if ((Get-FileHash -LiteralPath $control).Hash -ne $newRelease.launcherHash) { throw 'Recovery did not update the control launcher.' }
    if (Test-Path -LiteralPath $pending) { throw 'Recovery did not clear the activation journal.' }
    Set-CheckedExecutable $backup $agent $originalHash $newRelease.launcherHash
    if ((Get-FileHash -LiteralPath $agent).Hash -ne $originalHash) { throw 'Rollback did not restore the original executable.' }
    if (!(Test-Path -LiteralPath (Join-Path $newRuntime 'launcher.exe'))) { throw 'Rollback removed the prepared release.' }
    # Updating another harness with original selected can encounter an old launcher
    # after an interrupted restore (or legacy observe). Journal the restore too.
    New-Item -ItemType Directory -Path (Join-Path $state 'original') -Force | Out-Null
    Set-CheckedExecutable $backup (Join-Path $state 'original/opencode.exe') $originalHash
    foreach ($selected in @('original', 'observe')) {
        Set-CheckedExecutable (Join-Path $oldRuntime 'launcher.exe') $agent $oldRelease.launcherHash
        Publish-Release $state $oldRelease
        Write-AtomicJson (Join-Path $state 'backend.json') @{ mode = $selected }
        Write-AtomicJson "$agent.shadowbot-pi.json" @{ home = $state }
        Write-AtomicJson $pending @{ previousHash = $oldRelease.launcherHash; release = $newRelease; bundledMode = 'original' }
        $lock = [IO.File]::Open($control, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $interrupted = $false
            try { Complete-Activation $state $agent $originalHash {} } catch { $interrupted = $true }
            if (!$interrupted -or (Get-FileHash -LiteralPath $agent).Hash -ne $originalHash) { throw 'Bundled activation did not reach the interrupted restore state.' }
            if (!(Test-Path -LiteralPath $pending)) { throw 'Bundled activation lost recovery journal.' }
        } finally { $lock.Dispose() }
        Complete-Activation $state $agent $originalHash {}
        if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).launcherHash -ne $newRelease.launcherHash) { throw 'Bundled update failed to publish new manager.' }
        if ((Get-Content -LiteralPath (Join-Path $state 'backend.json') -Raw | ConvertFrom-Json).mode -ne 'original') { throw 'Legacy observe selection was not normalized.' }
        if ((Test-Path -LiteralPath $pending) -or (Test-Path -LiteralPath "$agent.shadowbot-pi.json")) { throw 'Bundled restore retained owned launcher metadata.' }
        # A subsequent install must accept the restored hash and activate normally.
        Write-AtomicJson $pending @{ previousHash = $originalHash; release = $newRelease }
        Complete-Activation $state $agent $originalHash {}
        if ((Get-FileHash -LiteralPath $agent).Hash -ne $newRelease.launcherHash) { throw 'Bundled update stranded the next activation.' }
    }
    Write-Output 'Installation activation, interrupted upgrade recovery and executable rollback passed.'
} finally {
    $target = (Resolve-Path -LiteralPath $root).Path
    if ($target -ne $root -or (Split-Path $target) -ne $base) { throw 'Unexpected test directory.' }
    Remove-Item -LiteralPath $target -Recurse -Force
}
