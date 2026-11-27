. (Join-Path $PSScriptRoot 'harnesses.ps1')
. (Join-Path $PSScriptRoot 'discovery.ps1')
function Get-OpenCodeVersion($Path, $Fallback) {
    try {
        $version = (& $Path --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $version -match '^\d+\.\d+\.\d+') { return $version }
    } catch {}
    $Fallback
}

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

function Copy-Executable($Source, $Destination, [scriptblock]$BeforeReplace) {
    $temp = "$Destination.$PID.tmp"
    try {
        Copy-Item -LiteralPath $Source -Destination $temp -Force
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
    Copy-Executable $launcher (Join-Path $State 'shadowbot-pi.exe')
    Write-AtomicJson (Join-Path $State 'install.json') $Release
}

function Complete-Activation($State, [scriptblock]$CheckStopped) {
    $path = Join-Path $State 'activation.pending.json'
    if (!(Test-Path -LiteralPath $path)) { return }
    & $CheckStopped
    $pending = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
    $release = $pending.release
    $agentPath = $release.agentPath
    if (![IO.Path]::IsPathFullyQualified($agentPath) -or (Split-Path -Leaf $agentPath) -ne 'opencode.exe') { throw 'Invalid activation target.' }
    if (!(Test-Path -LiteralPath $agentPath -PathType Leaf)) {
        Write-Warning "影刀程序已移除，丢弃旧激活记录：$agentPath"
        Remove-Item -LiteralPath $path
        return
    }
    $launcher = Join-Path (Get-InstallationRuntime $State $release) 'launcher.exe'
    $bundled = $pending.bundledMode
    if ($bundled -and $bundled -cnotmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'Invalid bundled harness in activation journal.' }
    $source = if ($bundled) { Join-Path $State 'original/opencode.exe' } else { $launcher }
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少激活文件：$source" }
    $locator = "$agentPath.shadowbot-pi.json"
    if (Test-Path -LiteralPath $locator) {
        $owner = Get-ShadowBotLocatorHome $locator
        $legacy = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ShadowBotPi'
        if ($owner -notin $State,$legacy) { throw '活动程序不属于此项目，请运行 repair。' }
    }
    if (!$bundled) { Write-AtomicJson $locator @{ home = $State } }
    Copy-Executable $source $agentPath -BeforeReplace $CheckStopped
    Publish-Release $State $release
    if ($bundled) {
        Write-AtomicJson (Join-Path $State 'backend.json') @{ mode = $bundled }
        if ((Test-Path -LiteralPath $locator) -and (Get-ShadowBotLocatorHome $locator) -in $State,$legacy) { Remove-Item -LiteralPath $locator -Force }
    }
    Remove-Item -LiteralPath $path -Force
}
