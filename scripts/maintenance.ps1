. (Join-Path $PSScriptRoot 'activation.ps1')
. (Join-Path $PSScriptRoot 'processes.ps1')

function Repair-InstallationLocator($State, $ExpectedOriginalHash, [scriptblock]$CheckStopped) {
    $manifest = Join-Path $State 'install.json'
    $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    if ($installation.originalHash -ne $ExpectedOriginalHash -or (Get-FileHash -LiteralPath (Join-Path $State 'original/opencode.exe')).Hash -ne $ExpectedOriginalHash) { throw '原程序备份校验失败，不能修复。' }
    $locator = "$($installation.agentPath).shadowbot-pi.json"
    if (Test-Path -LiteralPath $locator) {
        $oldState = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json -AsHashtable).home
        if ($oldState -ne $State -and (Test-Path -LiteralPath $oldState)) { throw "原项目仍存在：$oldState。请从原项目操作，避免接管另一套会话。" }
    }
    & $CheckStopped
    Complete-Activation $State $installation.agentPath $ExpectedOriginalHash $CheckStopped
    $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    $runtime = Get-InstallationRuntime $State $installation
    if ((Get-FileHash -LiteralPath (Join-Path $runtime 'launcher.exe')).Hash -ne $installation.launcherHash) { throw '运行时启动器校验失败，不能修复。' }
    $active = (Get-FileHash -LiteralPath $installation.agentPath).Hash
    if ($active -ne $ExpectedOriginalHash -and $active -ne $installation.launcherHash) { throw '活动程序不属于此项目，不能修复定位。' }
    if ($active -ne $ExpectedOriginalHash) { Write-AtomicJson $locator @{ home = $State } }
    Publish-Release $State $installation
}

function Repair-ProjectLocation($Project, [string]$ShadowBotDirectory, [switch]$Wait, [int]$WaitTimeoutSeconds = 300) {
    $state = Join-Path $Project '.shadowbot-switch'
    $manifest = Join-Path $state 'install.json'
    if (!(Test-Path -LiteralPath $manifest)) { throw '缺少安装记录。请先运行 use <harness>；已有会话数据请保留。' }
    $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    if ($ShadowBotDirectory -and (Split-Path (Split-Path $installation.agentPath)) -ne (Resolve-Path -LiteralPath $ShadowBotDirectory).Path) { throw '搬迁修复只能用于原影刀安装；新设备请使用 config import。' }
    $pinnedHash = 'DE2E62AB0E3F27A3EA7FF9EF4C4FE7097F0D6DF01118B2E7C5F57726256D6314'
    Invoke-InstallationLock $installation.agentPath {
        Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
        Repair-InstallationLocator $state $pinnedHash ${function:Assert-SwitchProcessesStopped}
    }
    $backend = (Get-Content -LiteralPath (Join-Path $state 'backend.json') -Raw | ConvertFrom-Json -AsHashtable).mode
    $harness = if ($backend -eq 'observe') { (Get-BundledHarness $Project).id } else { $backend }
    & (Join-Path $Project 'install.ps1') -Harness $harness -Wait:$Wait -WaitTimeoutSeconds $WaitTimeoutSeconds
    Write-Host '修复完成。如果配置里写了绝对路径，运行 .\switch.ps1 config check 检查是否还有效。'
}
