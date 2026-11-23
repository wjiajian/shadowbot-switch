param([ValidateSet('direct', 'aliyun')][string]$Mirror, [string]$OfflineToolchainDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'toolchain.ps1')
. (Join-Path $PSScriptRoot 'activation.ps1')
$project = Split-Path $PSScriptRoot
Invoke-InstallationLock $project { Build-Bridge $project (Initialize-Toolchain $project $Mirror $OfflineToolchainDir) }
