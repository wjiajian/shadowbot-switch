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
    # Generate a real Windows version resource for the pwsh -File stdout test.
    $source = Join-Path $root 'OldHost.cs'
    Set-Content $source '[assembly: System.Reflection.AssemblyInformationalVersion("5.0.0")] public class OldHost { public static void Main() {} }'
    & "$env:SystemRoot/Microsoft.NET/Framework/v4.0.30319/csc.exe" /nologo "/out:$(Join-Path $root 'ShadowBot.exe')" $source
    if ($LASTEXITCODE -ne 0) { throw 'Unable to build low-version host fixture.' }
    $agent = Join-Path $root 'shadowbot-6.10.0/opencode.exe'
    @{ agentPath = (Join-Path (Split-Path $agent) './opencode.exe') } | ConvertTo-Json | Set-Content (Join-Path $root 'install.json')
    $scriptPath = Join-Path (Split-Path $PSScriptRoot) 'scripts/discovery.ps1'
    $pwshPath = (Get-Process -Id $PID).Path
    foreach ($owner in "$root/", (Join-Path $root 'different-project')) {
        @{ home = $owner } | ConvertTo-Json | Set-Content "$agent.shadowbot-pi.json"
        $data = (& $pwshPath -NoProfile -File $scriptPath -InspectInstallation $root -SelectedHarness pi | Out-String) | ConvertFrom-Json
        if ($data.hostVersion -ne '5.0.0') { throw 'Expected low-version inspection.' }
        if ($owner -eq "$root/") {
            if ($data.attachment -ne 'managed' -or $data.warning) { throw 'Equivalent locator and executable paths must match.' }
        } elseif ($data.attachment -ne 'other' -or $data.action -ne 'repair') { throw 'Expected repair for a different locator.' }
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
    # Redirect the copied installer's host profile to the fixture for both success and failure cases.
    $installer = Join-Path $project 'install.ps1'
    $copy = (Get-Content -Raw $installer).Replace("[Environment]::GetFolderPath('LocalApplicationData')", "(Join-Path `$project 'profile')")
    Set-Content -LiteralPath $installer -Value $copy
    $profileDir = Join-Path $project 'profile/ShadowBot'
    $db = Join-Path $profileDir 'opencode/runtime/shared/xdg_data/opencode/opencode.db'
    New-Item -ItemType Directory -Force (Split-Path $db) | Out-Null
    @{ agentPath = $old; database = $db; users = Join-Path $profileDir 'users'; harnesses = @{ pi = @{ version = '1.5.2' } } } | ConvertTo-Json | Set-Content (Join-Path $state 'install.json')
    @{ mode = 'original' } | ConvertTo-Json | Set-Content (Join-Path $state 'backend.json')
    @{ home = $state } | ConvertTo-Json | Set-Content "$old.shadowbot-pi.json"
    $binding = Get-ShadowBotAttachment $state $old pi
    if (!$binding.warning -or $binding.agentPath -ne $new -or $binding.attachment -ne 'bundled') { throw 'Upgrade misreported as an active managed harness.' }
    $nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    New-Item -ItemType Directory (Join-Path $project 'src') | Out-Null
    Copy-Item (Join-Path $repo 'src/history-ownership.ts') (Join-Path $project 'src')
    Copy-Item $nodePath (Join-Path $state 'node.exe')
    & $nodePath --disable-warning=ExperimentalWarning -e "const d=new (require('node:sqlite').DatabaseSync)(process.argv[1]); d.exec('CREATE TABLE session(id TEXT); INSERT INTO session VALUES(1)')" $db
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create mixed fixture.' }
    @{ mode = 'pi' } | ConvertTo-Json | Set-Content (Join-Path $state 'backend.json')
    foreach ($destination in 'pi','original') {
        try {
            & (Join-Path $project 'install.ps1') -Harness $destination -ShadowBotDirectory $hostDir
            throw 'Expected mixed history to block activation.'
        } catch { if ($_.Exception.Message -notmatch '会话归属检查未通过') { throw } }
        if ((Get-Content $old) -ne 'launcher' -or (Get-Content $backup) -ne '1.19.0' -or !(Test-Path "$old.shadowbot-pi.json")) { throw 'Mixed history preflight modified the installation.' }
        if ((Get-Content (Join-Path $state 'install.json') -Raw | ConvertFrom-Json).agentPath -ne $old) { throw 'Manifest changed on failed preflight.' }
    }
    @{ mode = 'original' } | ConvertTo-Json | Set-Content (Join-Path $state 'backend.json')
    & (Join-Path $project 'install.ps1') -Harness original -ShadowBotDirectory $hostDir
    $install = Get-Content (Join-Path $state 'install.json') -Raw | ConvertFrom-Json
    $binding = Get-ShadowBotAttachment $state $install.agentPath original
    if ($binding.warning -or $binding.attachment -ne 'bundled') { throw 'Restored bundled installation should be active.' }
    if ((Get-Content $old) -ne '1.19.0' -or (Test-Path "$old.shadowbot-pi.json")) { throw 'Old host was not restored before replacing backup.' }
    if ((Get-Content $backup) -ne '1.20.0' -or $install.bundled.version -ne '1.20.0' -or $install.agentPath -ne $new -or $install.resources -ne (Join-Path (Split-Path $new) 'Resources')) { throw 'Upgrade lost new host metadata or backup.' }
} finally { Remove-Item -LiteralPath $project -Recurse -Force }
