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

    $backup = Join-Path $state 'opencode.original.exe'
    Copy-Executable $agent $backup
    Set-Content -LiteralPath (Join-Path $oldRuntime 'launcher.exe') -Value 'Previous launcher fixture'
    Set-Content -LiteralPath (Join-Path $newRuntime 'launcher.exe') -Value 'Updated launcher fixture'
    $oldRelease = @{ agentPath = $agent; runtimeRelease = $oldID }
    $newRelease = @{ agentPath = $agent; runtimeRelease = $newID; piVersion = '1.5.2' }

    Write-AtomicJson $pending @{ release = $oldRelease; previousHash = 'legacy-field' }
    Complete-Activation $state {}
    if ((Get-Content -LiteralPath $agent) -ne 'Previous launcher fixture') { throw 'Initial activation did not replace the agent.' }
    if ((Get-Content -LiteralPath "$agent.shadowbot-pi.json" -Raw | ConvertFrom-Json).home -ne $state) { throw 'Launcher location was not published.' }
    if ((Get-Content -LiteralPath $control) -ne 'Previous launcher fixture') { throw 'Control launcher was not published.' }
    if (Test-Path -LiteralPath $pending) { throw 'Initial activation journal was not cleared.' }

    Write-AtomicJson (Join-Path $state 'prepared.json') $newRelease
    if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $oldID) { throw 'Staging changed the active release.' }
    Write-AtomicJson $pending @{ release = $newRelease }
    $publish = ${function:Publish-Release}
    if ($IsWindows) { $lock = [IO.File]::Open($control, 'Open', 'Read', 'Read') }
    else { function Publish-Release { throw 'Simulated interruption during publication.' } }
    try {
        $interrupted = $false
        try { Complete-Activation $state {} }
        catch { $interrupted = $true }
        if (!$interrupted) { throw 'Expected the locked control executable to interrupt activation.' }
        if ((Get-Content -LiteralPath $agent) -ne 'Updated launcher fixture') { throw 'Fixture did not interrupt activation after replacing the agent.' }
        if (!(Test-Path -LiteralPath $pending)) { throw 'Interrupted activation lost its recovery journal.' }
        if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $oldID) { throw 'Interrupted activation committed the manifest too early.' }
    } finally { if ($IsWindows) { $lock.Dispose() } else { ${function:Publish-Release} = $publish } }

    Complete-Activation $state {}
    if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $newID) { throw 'Recovery did not publish the prepared release.' }
    if ((Get-Content -LiteralPath $control) -ne 'Updated launcher fixture') { throw 'Recovery did not update the control launcher.' }
    if (Test-Path -LiteralPath $pending) { throw 'Recovery did not clear the activation journal.' }
    Copy-Executable $backup $agent
    if ((Get-Content -LiteralPath $agent) -ne 'Original OpenCode fixture') { throw 'Rollback did not restore the original executable.' }
    if (!(Test-Path -LiteralPath (Join-Path $newRuntime 'launcher.exe'))) { throw 'Rollback removed the prepared release.' }
    # Updating another harness with original selected can encounter an old launcher
    # after an interrupted restore (or legacy observe). Journal the restore too.
    New-Item -ItemType Directory -Path (Join-Path $state 'original') -Force | Out-Null
    Copy-Executable $backup (Join-Path $state 'original/opencode.exe')
    foreach ($selected in @('original', 'observe')) {
        Copy-Executable (Join-Path $oldRuntime 'launcher.exe') $agent
        Publish-Release $state $oldRelease
        Write-AtomicJson (Join-Path $state 'backend.json') @{ mode = $selected }
        Write-AtomicJson "$agent.shadowbot-pi.json" @{ home = $state }
        Write-AtomicJson $pending @{ release = $newRelease; bundledMode = 'original' }
        $publish = ${function:Publish-Release}
        if ($IsWindows) { $lock = [IO.File]::Open($control, 'Open', 'Read', 'Read') }
        else { function Publish-Release { throw 'Simulated interruption during publication.' } }
        try {
            $interrupted = $false
            try { Complete-Activation $state {} } catch { $interrupted = $true }
            if (!$interrupted -or (Get-Content -LiteralPath $agent) -ne 'Original OpenCode fixture') { throw 'Bundled activation did not reach the interrupted restore state.' }
            if (!(Test-Path -LiteralPath $pending)) { throw 'Bundled activation lost recovery journal.' }
        } finally { if ($IsWindows) { $lock.Dispose() } else { ${function:Publish-Release} = $publish } }
        Complete-Activation $state {}
        if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).runtimeRelease -ne $newID) { throw 'Bundled update failed to publish new manager.' }
        if ((Get-Content -LiteralPath (Join-Path $state 'backend.json') -Raw | ConvertFrom-Json).mode -ne 'original') { throw 'Legacy observe selection was not normalized.' }
        if ((Test-Path -LiteralPath $pending) -or (Test-Path -LiteralPath "$agent.shadowbot-pi.json")) { throw 'Bundled restore retained owned launcher metadata.' }
        # A subsequent install must accept the restored original and activate normally.
        Write-AtomicJson $pending @{ release = $newRelease }
        Complete-Activation $state {}
        if ((Get-Content -LiteralPath $agent) -ne 'Updated launcher fixture') { throw 'Bundled update stranded the next activation.' }
    }
    Remove-Item -LiteralPath $agent
    Write-AtomicJson $pending @{ release = $newRelease }
    Complete-Activation $state {}
    if (Test-Path -LiteralPath $pending) { throw 'Missing agent retained stale journal.' }
    Write-Output 'Installation activation, interrupted upgrade recovery and executable rollback passed.'
} finally {
    $target = (Resolve-Path -LiteralPath $root).Path
    if ($target -ne $root -or (Split-Path $target) -ne $base) { throw 'Unexpected test directory.' }
    Remove-Item -LiteralPath $target -Recurse -Force
}
