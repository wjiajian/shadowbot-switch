#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
$arguments = @($args | ForEach-Object { [string]$_ })
$project = $PSScriptRoot
$state = Join-Path $project '.shadowbot-switch'
$manifestPath = Join-Path $state 'install.json'
$control = Join-Path $state 'shadowbot-pi.exe'
$jsonOutput = $arguments -contains '--json'

function Show-Help {
    @'
ShadowBot Switch — 在项目根目录管理影刀 Copilot

  .\switch.ps1                         当前状态和菜单
  .\switch.ps1 use <harness>           安装 / 切换 harness（例如 use pi）
  .\switch.ps1 harnesses               查看已注册的 harness 和能力
  .\switch.ps1 use original            恢复影刀原版与原聊天记录
  .\switch.ps1 status                  查看当前后端和配置状态
  .\switch.ps1 doctor                  完整诊断及修复提示
  .\switch.ps1 reload                  刷新 Skill 菜单和 MCP 配置
  .\switch.ps1 skills                  查看 Skill 来源、启用状态和问题
  .\switch.ps1 skills add <目录>        添加 Skill（放入即用）
  .\switch.ps1 skills enable|disable|remove <名称>
  .\switch.ps1 mcp                     查看配置，不启动服务
  .\switch.ps1 mcp test [名称]          独立检查连接
  .\switch.ps1 mcp status              查看运行中的 Copilot 连接
  .\switch.ps1 mcp add <名称> --url <URL>
  .\switch.ps1 mcp add <名称> --command <程序> --arg <参数>
  .\switch.ps1 mcp enable|disable|remove <名称>
  .\switch.ps1 config open [mcp|skills] 创建并打开配置
  .\switch.ps1 config check            配置及路径检查
  .\switch.ps1 config export <文件>     导出配置
  .\switch.ps1 config import <文件>     导入配置，--replace 先备份再覆盖
  .\switch.ps1 apps list|select|clear   选择应用或恢复安装级默认范围
  .\switch.ps1 update [harness]        更新指定或当前 harness，保持当前选择
  .\switch.ps1 repair                  修复项目搬迁定位及中断的操作

通用：--json；--global；--app <应用路径>。
切换：--shadowbot-dir <影刀安装目录>；--wait（等待退出）；--timeout <秒>。
未选择应用时默认管理此安装的全部应用；apps select 会记住选择。
Skill 与权限下一轮生效；MCP 在空闲后的下一轮自动应用。
原生 / 菜单文件更新后，重新连接 Copilot 即可显示。
'@
}

function Read-LocalStatus {
    $result = [ordered]@{ installed = $false; backend = 'unknown'; recoveryPending = $false; next = '.\switch.ps1 harnesses' }
    if (Test-Path -LiteralPath $manifestPath) {
        try {
            $installation = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $backend = Get-Content -LiteralPath (Join-Path $state 'backend.json') -Raw | ConvertFrom-Json
            $result.installed = $true
            $record = if ($installation.harnesses) { $installation.harnesses.PSObject.Properties[$backend.mode].Value } else { $null }
            $result.backend = "$($backend.mode) $($record.version)".Trim()
            $result.recoveryPending = (Test-Path -LiteralPath (Join-Path $state 'activation.pending.json')) -or (Test-Path -LiteralPath (Join-Path $state 'switch.pending.json'))
            $result.next = if ($result.recoveryPending) { '.\switch.ps1 repair' } else { '.\switch.ps1 doctor' }
        } catch { $result.next = '安装记录无法读取。保留 .shadowbot-switch 数据，恢复安装记录后运行 .\switch.ps1 repair。' }
    }
    [pscustomobject]$result
}

function Invoke-Selection([string]$Command, [string[]]$Tail, [string]$Target) {
    $parameters = @{}
    for ($i = 0; $i -lt $Tail.Count; $i++) {
        switch ($Tail[$i]) {
            '--json' { }
            '--wait' { $parameters.Wait = $true }
            '--timeout' { $i++; if ($i -ge $Tail.Count) { throw '--timeout 需要秒数。' }; $parameters.WaitTimeoutSeconds = [int]$Tail[$i] }
            '--shadowbot-dir' { $i++; if ($i -ge $Tail.Count) { throw '--shadowbot-dir 需要路径。' }; $parameters.ShadowBotDirectory = $Tail[$i] }
            default { throw "未知切换选项：$($Tail[$i])" }
        }
    }
    if ($Command -eq 'repair') {
        . (Join-Path $project 'scripts/maintenance.ps1')
        Repair-ProjectLocation $project @parameters
        return
    }
    . (Join-Path $project 'scripts/harnesses.ps1')
    if ($Command -eq 'update') {
        $target = if ($Target) { $Target } else { Get-SelectedHarness $state $project }
        $harness = (Get-Harness $project $target).id
        & (Join-Path $project 'install.ps1') -Harness $harness -Update @parameters
        return
    }
    $harness = (Get-Harness $project $Target).id
    & (Join-Path $project 'install.ps1') -Harness $harness @parameters
}

try {
    if (!$arguments.Count) {
        $status = Read-LocalStatus
        Write-Host "当前后端：$($status.backend)"
        if (!$status.installed) { Write-Host '尚未安装托管 harness。' }
        if ([Console]::IsInputRedirected) { Show-Help; return }
        . (Join-Path $project 'scripts/harnesses.ps1')
        $registered = @(Get-HarnessRegistry $project)
        for ($i = 0; $i -lt $registered.Count; $i++) { Write-Host "$($i + 1) 切换 $($registered[$i].name)" }
        Write-Host 'r 刷新配置  d 诊断  h 帮助  0 退出'
        $choice = Read-Host '选择操作'
        if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $registered.Count) { $arguments = @('use', $registered[[int]$choice - 1].id, '--wait') }
        else { $arguments = switch ($choice) { 'r' { @('reload') }; 'd' { @('doctor') }; '0' { return }; default { @('help') } } }
        if (!$arguments.Count) { return }
    }
    $command = $arguments[0]
    if ($command -in 'help', '--help', '-h') { Show-Help; return }
    if ($command -eq 'use') {
        if ($arguments.Count -lt 2) { throw '请使用 .\switch.ps1 use <harness>；harnesses 查看可用列表。' }
        Invoke-Selection 'use' @($arguments | Select-Object -Skip 2) $arguments[1]
        return
    }
    if ($command -eq 'harnesses') {
        . (Join-Path $project 'scripts/harnesses.ps1')
        $registered = @(Get-HarnessRegistry $project)
        if ($jsonOutput) { $registered | ConvertTo-Json -Depth 8 } else { $registered | Select-Object id, name, kind, capabilities | Format-Table }
        return
    }
    if ($command -in 'update', 'repair') {
        $tail = @($arguments | Select-Object -Skip 1)
        $target = $null
        if ($command -eq 'update' -and $tail.Count -and !$tail[0].StartsWith('--')) {
            $target = $tail[0]; $tail = @($tail | Select-Object -Skip 1)
        }
        Invoke-Selection $command $tail $target
        return
    }
    $status = Read-LocalStatus
    if (!$status.installed -or !(Test-Path -LiteralPath $control)) {
        if ($jsonOutput) { $status | ConvertTo-Json }
        else { Write-Host "当前后端：$($status.backend)"; Write-Host "下一步：$($status.next)" }
        if ($command -notin 'status', 'doctor') { throw '安装尚未就绪。先运行 .\switch.ps1 use <harness>。' }
        if ($command -eq 'doctor') { $global:LASTEXITCODE = 1; exit 1 }
        return
    }
    & $control @arguments
    if ($LASTEXITCODE -ne 0) {
        if (!$jsonOutput -and $command -in 'status', 'doctor') { Write-Host "本地安装记录：$($status.backend)；下一步：$($status.next)" }
        exit $LASTEXITCODE
    }
} catch {
    if ($jsonOutput) { @{ error = $_.Exception.Message } | ConvertTo-Json }
    else { Write-Host "ShadowBot Switch：$($_.Exception.Message)" -ForegroundColor Red }
    exit 1
}
