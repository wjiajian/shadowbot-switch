#requires -Version 7.0
$ErrorActionPreference = 'Stop'
# Output read by another process (for example `status --json`) must be UTF-8. Windows otherwise
# encodes redirected output with the OEM code page, such as GBK on Chinese systems.
if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) }
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
  .\switch.ps1 ui                      打开图形界面
  .\switch.ps1 use <harness>           安装 / 切换 harness（例如 use pi）
  .\switch.ps1 harnesses               查看已注册的 harness 和能力
  .\switch.ps1 use original            恢复影刀原版与原聊天记录
  .\switch.ps1 status                  查看当前后端和配置状态
  .\switch.ps1 doctor                  完整诊断及修复提示
  .\switch.ps1 reload                  刷新 Skill 菜单和 MCP 配置
  .\switch.ps1 skills                  查看 Skill 来源、启用状态和问题
  .\switch.ps1 skills add <目录>        添加 Skill（下一轮对话生效）
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
  .\switch.ps1 config import <文件> --dry-run  预览目标和冲突
  .\switch.ps1 config backups [--limit n] [--offset n]
  .\switch.ps1 config restore <备份编号> [--dry-run]
  .\switch.ps1 rules show / settings show  查看规则或授权设置
  .\switch.ps1 rules save|remove --scope installation|application --expect <摘要|absent>（保存加 --from <文件>）
  .\switch.ps1 settings save --from <补丁文件> --expect <摘要|absent>
  .\switch.ps1 log [--limit n] [--offset n]  查看最近切换
  .\switch.ps1 apps add|remove <路径>   管理自定义应用
  .\switch.ps1 apps list|select|clear   选择应用或恢复安装级默认范围
  .\switch.ps1 update [harness]        检查上游同主版本并更新指定或当前 harness，保持当前选择
  .\switch.ps1 update [harness] --check   只检查版本（--all 检查全部）
  更新选项：--local-only 仅本地重建；--version <版本> 指定版本；--pinned 恢复仓库锁定版本。
  .\switch.ps1 uninstall             恢复原版，清理工具链和运行时；--purge-data 删除历史，--yes 确认
  .\switch.ps1 repair                  修复项目搬迁定位及中断的操作

安装、更新和修复：--mirror <direct|aliyun>；--offline-dir <离线包目录>。
通用：--json；--global；--app <应用路径>。
切换：--shadowbot-dir <影刀安装目录>；--wait（等待退出）；--timeout <秒>。
未选择应用时默认管理此安装的全部应用；apps select 会记住选择。
Skill 与权限下一轮生效；MCP 在空闲后的下一轮自动应用。
原生 / 菜单文件更新后，重新连接 Copilot 即可显示。
'@
}

function Read-LocalStatus {
    $result = [ordered]@{ installed = $false; backend = 'unknown'; recoveryPending = $false; next = '运行 .\switch.ps1 use pi 安装 Pi；.\switch.ps1 harnesses 查看全部选项。' }
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
            { $_ -in '--check','--all','--local-only','--pinned','--version' } {
                if ($Command -ne 'update') { throw "不支持的选项：$_" }
                if ($_ -eq '--version') {
                    $i++
                    if ($i -ge $Tail.Count -or !$Tail[$i] -or $Tail[$i].StartsWith('--')) { throw '--version 需要版本号。' }
                    $parameters.HarnessVersion = $Tail[$i]
                } else {
                    $key = @{ '--check'='Check'; '--all'='All'; '--local-only'='LocalOnly'; '--pinned'='Pinned' }[$_]
                    $parameters[$key] = $true
                }
            }
            '--wait' { $parameters.Wait = $true }
            { $_ -in '--mirror', '--offline-dir' } {
                if ($Command -notin 'use', 'update', 'repair') { throw "不支持的选项：$_" }
                $key = if ($_ -eq '--mirror') { 'Mirror' } else { 'OfflineToolchainDir' }
                $i++
                if ($i -ge $Tail.Count -or !$Tail[$i] -or $Tail[$i].StartsWith('--')) { throw "$_ 需要参数。" }
                if ($key -eq 'Mirror' -and $Tail[$i] -notin 'direct', 'aliyun') { throw '下载源无效，请选择 direct 或 aliyun。' }
                $parameters[$key] = $Tail[$i]
            }
            { $_ -in '--purge-data', '--yes' } {
                if ($Command -ne 'uninstall') { throw "不支持的选项：$_" }
                if ($_ -eq '--yes') { $parameters.Yes = $true } else { $parameters.PurgeData = $true }
            }
            '--timeout' { $i++; if ($i -ge $Tail.Count) { throw '--timeout 需要秒数。' }; $parameters.WaitTimeoutSeconds = [int]$Tail[$i] }
            '--shadowbot-dir' { $i++; if ($i -ge $Tail.Count) { throw '--shadowbot-dir 需要路径。' }; $parameters.ShadowBotDirectory = $Tail[$i] }
            default { throw "未知切换选项：$($Tail[$i])" }
        }
    }
    if ($Command -eq 'uninstall') {
        . (Join-Path $project 'scripts/maintenance.ps1')
        $result = if ($jsonOutput) { Uninstall-Project $project @parameters 6>$null } else { Uninstall-Project $project @parameters }
        if ($jsonOutput) { $result | ConvertTo-Json -Depth 5 }
        else {
            if ($result.restored) { Write-Host "已恢复原版：$($result.restored)" }
            foreach ($path in $result.removed) { Write-Host "已清理：$path" }
            foreach ($path in $result.retained) { Write-Host "已保留：$path" }
        }
        if ($result.failed.Count) {
            $details = $result.failed | ForEach-Object { "$($_.path)（$($_.reason)）" }
            [Console]::Error.WriteLine("以下路径未清理成功：$($details -join '，')")
            exit 1
        }
        if (!$jsonOutput) { Write-Host '卸载完成。' }
        return
    }
    if ($jsonOutput) { $parameters.Json = $true }
    if ($Command -eq 'repair') {
        . (Join-Path $project 'scripts/maintenance.ps1')
        Invoke-InstallationLock $project { Repair-ProjectLocation $project @parameters }
        return
    }
    . (Join-Path $project 'scripts/harnesses.ps1')
    if ($Command -eq 'update') {
        . (Join-Path $project 'scripts/runtime.ps1')
        Assert-HarnessUpdateOptions $parameters $Target $null $true
        if ($parameters.Check) {
            . (Join-Path $project 'scripts/toolchain.ps1')
            $specs = if ($parameters.All) { Get-HarnessRegistry $project } else {
                if (!$Target) { $Target = Get-SelectedHarness $state $project }
                Get-Harness $project $Target
            }
            $report = Get-HarnessUpdateReport $project $state $specs (Get-ToolchainSource $parameters.Mirror $parameters.OfflineToolchainDir)
            Write-HarnessUpdateReport $report -Json:$jsonOutput
            if (@($report.harnesses | Where-Object { $_.status -eq 'error' }).Count) { exit 1 }
            return
        }
        $target = if ($Target) { $Target } else { Get-SelectedHarness $state $project }
        $harness = (Get-Harness $project $target).id
        Assert-HarnessUpdateOptions $parameters $null (Get-Harness $project $harness) $true
        & (Join-Path $project 'install.ps1') -Harness $harness -Update @parameters
        return
    }
    $harness = (Get-Harness $project $Target).id
    & (Join-Path $project 'install.ps1') -Harness $harness @parameters
}

try {
    if (!$arguments.Count) {
        $status = Read-LocalStatus
        if ($status.installed) { Write-Host "当前后端：$($status.backend)" }
        else { Write-Host '还没有安装，从下面选择一个后端开始。' }
        if ([Console]::IsInputRedirected) { Show-Help; return }
        . (Join-Path $project 'scripts/harnesses.ps1')
        $registered = @(Get-HarnessRegistry $project)
        for ($i = 0; $i -lt $registered.Count; $i++) { Write-Host "$($i + 1) 切换 $($registered[$i].name)" }
        Write-Host 'r 刷新配置  d 诊断  u 图形界面  h 帮助  0 退出'
        $choice = Read-Host '选择操作'
        if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $registered.Count) { $arguments = @('use', $registered[[int]$choice - 1].id, '--wait') }
        elseif ($choice -eq '0') { return }
        # switch output is unrolled, so wrap it: a bare 'reload' would make $arguments[0] the letter 'r'.
        else { $arguments = @(switch ($choice) { 'r' { 'reload' }; 'd' { 'doctor' }; 'u' { 'ui' }; default { 'help' } }) }
    }
    $command = $arguments[0]
    if ($command -in 'help', '--help', '-h') { Show-Help; return }
    if ($command -eq 'ui') { & (Join-Path $project 'ui.ps1'); return }
    if ($command -eq 'use') {
        if ($arguments.Count -lt 2) { throw '请使用 .\switch.ps1 use <harness>；harnesses 查看可用列表。' }
        Invoke-Selection 'use' @($arguments | Select-Object -Skip 2) $arguments[1]
        return
    }
    if ($command -eq 'harnesses') {
        . (Join-Path $project 'scripts/harnesses.ps1')
        $registered = @(Get-HarnessRegistry $project)
        if ($jsonOutput) { $registered | ConvertTo-Json -Depth 8 }
        else {
            $current = try { Get-SelectedHarness $state $project } catch { $null }
            $registered | Select-Object @{ n = '标识'; e = { $_.id } }, @{ n = '名称'; e = { $_.name } },
                @{ n = 'Skill'; e = { if ($_.capabilities.skills) { '是' } else { '否' } } },
                @{ n = 'MCP'; e = { if ($_.capabilities.mcp) { '是' } else { '否' } } },
                @{ n = '正在使用'; e = { if ($_.id -eq $current) { '是' } else { '' } } } | Format-Table -AutoSize
        }
        return
    }
    if ($command -in 'update', 'repair', 'uninstall') {
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
        else { Write-Host "当前后端：$(if ($status.installed) { $status.backend } else { '未安装' })"; Write-Host "下一步：$($status.next)" }
        if ($command -notin 'status', 'doctor') { throw '安装尚未就绪。先运行 .\switch.ps1 use <harness>。' }
        if ($command -eq 'doctor') { $global:LASTEXITCODE = 1; exit 1 }
        return
    }
    # Carry new commands through the installed launcher's config namespace.
    if ($command -cin 'rules','settings','log') { $arguments = @('config') + $arguments }
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
