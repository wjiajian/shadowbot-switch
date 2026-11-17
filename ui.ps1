#requires -Version 7.0
<#
.SYNOPSIS
打开 ShadowBot Switch 图形界面。

.DESCRIPTION
在本机随机端口启动一个只接受本机访问的小服务，并用 Edge 应用窗口打开界面。
关闭界面窗口后服务自动退出；切换任务进行中时，会等任务结束再退出。

.PARAMETER NoBrowser
不自动打开窗口，只在终端打印带 token 的地址。
#>
[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
# Chinese Windows defaults to a legacy code page; keep console text readable.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
. (Join-Path $PSScriptRoot 'scripts/ui-server.ps1')

try { Start-UiServer $PSScriptRoot -NoBrowser:$NoBrowser }
catch {
    Write-Host "ShadowBot Switch：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
