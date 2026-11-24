$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot) 'scripts/discovery.ps1')
$root = (New-Item -ItemType Directory (Join-Path ([IO.Path]::GetTempPath()) "switch-discovery-$([guid]::NewGuid())")).FullName
try {
    Set-Content (Join-Path $root 'ShadowBot.exe') 'fixture'
    try { Resolve-ShadowBotAgent $root; throw 'Expected empty discovery to fail.' }
    catch { if ($_.Exception.Message -notmatch '没有找到') { throw } }
    foreach ($version in '6.4.1','6.4.0','6.10.0') {
        $dir = New-Item -ItemType Directory (Join-Path $root "shadowbot-$version")
        Set-Content (Join-Path $dir 'opencode.exe') 'fixture'
        $expected = if ($version -eq '6.4.0') { '6.4.1' } else { $version }
        if ((Resolve-ShadowBotAgent $root).agentPath -ne (Join-Path $root "shadowbot-$expected/opencode.exe")) { throw 'Wrong host directory selected.' }
    }
} finally { Remove-Item -LiteralPath $root -Recurse -Force }

# Exercise use original against a host upgraded in place, with no real ShadowBot process or data.
$project = (New-Item -ItemType Directory (Join-Path ([IO.Path]::GetTempPath()) "switch-upgrade-$([guid]::NewGuid())")).FullName
try {
    $repo = Split-Path $PSScriptRoot
    foreach ($name in 'install.ps1','scripts','harnesses') { Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $project -Recurse }
    Add-Content (Join-Path $project 'scripts/runtime.ps1') @'
function Assert-SwitchProcessesStopped {}
function Wait-SwitchProcesses {}
function Get-OpenCodeVersion($Path,$Fallback) { Get-Content -LiteralPath $Path }
'@
    $state = Join-Path $project '.shadowbot-switch'
    $hostDir = Join-Path $project 'shadowbot'
    $old = Join-Path $hostDir 'shadowbot-6.4.0/opencode.exe'
    $new = Join-Path $hostDir 'shadowbot-6.4.1/opencode.exe'
    $backup = Join-Path $state 'original/opencode.exe'
    foreach ($file in $old,$new,$backup) { New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null }
    Set-Content (Join-Path $hostDir 'ShadowBot.exe') 'fixture'
    Set-Content $old 'launcher'
    Set-Content $new '1.20.0'
    Set-Content $backup '1.19.0'
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    @{ agentPath = $old; database = Join-Path $local 'ShadowBot/opencode/runtime/shared/xdg_data/opencode/opencode.db'
       users = Join-Path $local 'ShadowBot/users' } | ConvertTo-Json | Set-Content (Join-Path $state 'install.json')
    @{ mode = 'original' } | ConvertTo-Json | Set-Content (Join-Path $state 'backend.json')
    @{ home = $state } | ConvertTo-Json | Set-Content "$old.shadowbot-pi.json"
    & (Join-Path $project 'install.ps1') -Harness original -ShadowBotDirectory $hostDir
    $install = Get-Content (Join-Path $state 'install.json') -Raw | ConvertFrom-Json
    if ((Get-Content $old) -ne '1.19.0' -or (Test-Path "$old.shadowbot-pi.json")) { throw 'Old host was not restored before replacing backup.' }
    if ((Get-Content $backup) -ne '1.20.0' -or $install.bundled.version -ne '1.20.0' -or $install.agentPath -ne $new -or $install.resources -ne (Join-Path (Split-Path $new) 'Resources')) { throw 'Upgrade lost new host metadata or backup.' }
} finally { Remove-Item -LiteralPath $project -Recurse -Force }
