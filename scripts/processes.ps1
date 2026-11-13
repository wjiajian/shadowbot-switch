function Get-SwitchProcesses {
    $browserBridge = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ShadowBot/support_X64/Chrome/ShadowBot.ChromeBridge.exe'
    @(Get-Process -Name 'ShadowBot*', 'opencode' -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -ne 'shadowbot-pi' -and ($_.ProcessName -ne 'ShadowBot.ChromeBridge' -or $_.Path -ne $browserBridge)
    })
}

function Wait-SwitchProcesses([switch]$Wait, [int]$TimeoutSeconds = 300) {
    $running = @(Get-SwitchProcesses)
    if (!$running.Count) { return }
    Write-Host '运行文件已准备好。请保存工作，从托盘退出影刀，并关闭以下进程：'
    $running | Select-Object Id, ProcessName, Path | Format-Table | Out-Host
    if (!$Wait) { throw '影刀仍在运行。退出后重试，或添加 --wait 等待退出。' }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (@(Get-SwitchProcesses).Count) {
        if ([DateTime]::UtcNow -ge $deadline) { throw '等待退出超时，尚未切换。退出影刀后重新运行命令。' }
        Start-Sleep -Milliseconds 500
    }
}

function Assert-SwitchProcessesStopped {
    if (@(Get-SwitchProcesses).Count) { throw '影刀或 OpenCode 再次启动，已停止切换。请退出后重试。' }
}
