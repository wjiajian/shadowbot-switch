. (Join-Path $PSScriptRoot 'harnesses.ps1')
function Write-AtomicJson($Path, $Data) {
    $temp = "$Path.$PID.tmp"
    try {
        $contents = [Text.Encoding]::UTF8.GetBytes(($Data | ConvertTo-Json -Depth 16))
        $file = [IO.File]::Open($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($contents, 0, $contents.Length); $file.Flush($true) }
        finally { $file.Dispose() }
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temp, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}

function Set-CheckedExecutable($Source, $Destination, $SourceHash, $PreviousHash, [scriptblock]$BeforeReplace) {
    $temp = "$Destination.$PID.tmp"
    try {
        Copy-Item -LiteralPath $Source -Destination $temp -Force
        if ((Get-FileHash -LiteralPath $temp).Hash -ne $SourceHash) { throw 'Staged executable checksum mismatch.' }
        if ($PreviousHash -and (Get-FileHash -LiteralPath $Destination).Hash -ne $PreviousHash) {
            throw 'Active executable changed during installation.'
        }
        if ($BeforeReplace) { & $BeforeReplace }
        if (Test-Path -LiteralPath $Destination) { [IO.File]::Replace($temp, $Destination, [NullString]::Value) }
        else { [IO.File]::Move($temp, $Destination) }
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}

function Invoke-InstallationLock($AgentPath, [scriptblock]$Action) {
    # Match the previous control launcher's lock during migration.
    $nameHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($AgentPath.ToLowerInvariant()))).ToLowerInvariant()
    $mutex = [Threading.Mutex]::new($false, "Global\ShadowBotPi-$nameHash")
    try {
        try { $acquired = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (!$acquired) { throw '另一个安装或切换正在进行，等它结束后再试。' }
        try { & $Action }
        finally { $mutex.ReleaseMutex() }
    } finally { $mutex.Dispose() }
}

function Get-ReleasePath($State, $Id, $PiVersion, $Harness) {
    if ($Id -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid installation release ID.' }
    if ($Harness) {
        if ($Harness -cnotmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'Invalid harness ID.' }
        return Join-Path $State "harnesses/$Harness/releases/$Id"
    }
    if ($PiVersion) { Join-Path $State "harnesses/pi/releases/$Id" }
    else { Join-Path $State "releases/$Id" }
}

function Publish-Release($State, $Release) {
    $launcher = Join-Path (Get-InstallationRuntime $State $Release) 'launcher.exe'
    Set-CheckedExecutable $launcher (Join-Path $State 'shadowbot-pi.exe') $Release.launcherHash
    Write-AtomicJson (Join-Path $State 'install.json') $Release
}

function Complete-Activation($State, $AgentPath, $OriginalHash, [scriptblock]$CheckStopped) {
    $path = Join-Path $State 'activation.pending.json'
    if (!(Test-Path -LiteralPath $path)) { return }
    & $CheckStopped
    $pending = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $release = $pending.release | ConvertTo-Json -Depth 16 | ConvertFrom-Json -AsHashtable
    if ($release.agentPath -ne $AgentPath -or $release.originalHash -ne $OriginalHash -or
        $release.launcherHash -notmatch '^[0-9a-f]{64}$' -or $pending.previousHash -notmatch '^[0-9a-f]{64}$') {
        throw 'Activation journal does not match this installation.'
    }
    $launcher = Join-Path (Get-InstallationRuntime $State $release) 'launcher.exe'
    if ((Get-FileHash -LiteralPath $launcher).Hash -ne $release.launcherHash) { throw 'Staged launcher checksum mismatch.' }
    $bundled = $pending.bundledMode
    if ($bundled -and $bundled -cnotmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'Invalid bundled harness in activation journal.' }
    $desiredHash = if ($bundled) { $OriginalHash } else { $release.launcherHash }
    $source = if ($bundled) { Join-Path $State 'original/opencode.exe' } else { $launcher }
    if ((Get-FileHash -LiteralPath $source).Hash -ne $desiredHash) { throw 'Activation source checksum mismatch.' }
    $active = (Get-FileHash -LiteralPath $AgentPath).Hash
    if ($active -ne $desiredHash -and $active -ne $pending.previousHash) {
        throw 'Active launcher checksum does not match the activation journal.'
    }
    if (!$bundled) { Write-AtomicJson "$AgentPath.shadowbot-pi.json" @{ home = $State } }
    if ($active -ne $desiredHash) {
        Set-CheckedExecutable $source $AgentPath $desiredHash $pending.previousHash $CheckStopped
    }
    Publish-Release $State $release
    if ($bundled) {
        Write-AtomicJson (Join-Path $State 'backend.json') @{ mode = $bundled }
        $locator = "$AgentPath.shadowbot-pi.json"
        if ((Test-Path -LiteralPath $locator) -and (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home -eq $State) { Remove-Item -LiteralPath $locator -Force }
    }
    Remove-Item -LiteralPath $path -Force
}
