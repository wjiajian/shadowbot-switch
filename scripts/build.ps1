$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'toolchain.ps1')
$project = Split-Path $PSScriptRoot
Build-Bridge $project (Initialize-Toolchain $project)
