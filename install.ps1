#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ShadowBotDirectory,
    [string]$Harness,
    [switch]$Update,
    [switch]$Wait,
    [ValidateRange(1, 86400)][int]$WaitTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/activation.ps1')
. (Join-Path $PSScriptRoot 'scripts/discovery.ps1')
. (Join-Path $PSScriptRoot 'scripts/toolchain.ps1')
. (Join-Path $PSScriptRoot 'scripts/processes.ps1')
. (Join-Path $PSScriptRoot 'scripts/runtime.ps1')

$project = $PSScriptRoot
$state = Join-Path $project '.shadowbot-switch'
$local = [Environment]::GetFolderPath('LocalApplicationData')
$legacy = Join-Path $local 'ShadowBotPi'
$manifest = Join-Path $state 'install.json'
$mode = Join-Path $state 'backend.json'
$original = Join-Path $state 'original/opencode.exe'
$supportedVersion = '6.3.39'
$pinnedHash = 'DE2E62AB0E3F27A3EA7FF9EF4C4FE7097F0D6DF01118B2E7C5F57726256D6314'

if (!$Harness) {
    $registered = @(Get-HarnessRegistry $project)
    for ($i = 0; $i -lt $registered.Count; $i++) { Write-Host "$($i + 1). $($registered[$i].name) ($($registered[$i].id))" }
    $choice = Read-Host '选择 harness（编号或标识）'
    $Harness = if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $registered.Count) { $registered[[int]$choice - 1].id } else { $choice }
}
$spec = Get-Harness $project $Harness
$bundled = Get-BundledHarness $project
$Harness = $spec.id
if ($Update -and $spec.kind -eq 'bundled') {
    Write-Output "$($spec.name) 随影刀更新；当前选择和其他 harness 保持不变。"
    return
}
if (!$ShadowBotDirectory) { $ShadowBotDirectory = Find-ShadowBotDirectory $manifest }
if (!$ShadowBotDirectory -and ![Console]::IsInputRedirected) { $ShadowBotDirectory = Read-Host '影刀安装目录（包含 ShadowBot.exe）' }
if (!$ShadowBotDirectory) { throw 'A ShadowBot installation directory is required.' }

$shadowBot = (Resolve-Path -LiteralPath $ShadowBotDirectory).Path
$hostExe = Join-Path $shadowBot 'ShadowBot.exe'
$versionedDirectory = Join-Path $shadowBot "shadowbot-$supportedVersion"
$agentExe = Join-Path $versionedDirectory 'opencode.exe'
$locator = "$agentExe.shadowbot-pi.json"
$resources = Join-Path $versionedDirectory 'Resources'
$database = Join-Path $local 'ShadowBot/opencode/runtime/shared/xdg_data/opencode/opencode.db'
$hostSkills = Join-Path $local 'ShadowBot/opencode/runtime/shared/skills'
$users = Join-Path $local 'ShadowBot/users'

function Assert-HostStopped {
    Assert-SwitchProcessesStopped
}

function Read-Installation($StateDirectory) {
    $path = Join-Path $StateDirectory 'install.json'
    if (!(Test-Path -LiteralPath $path)) { return $null }
    $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
    if ($existing.agentPath -ne $agentExe -or $existing.originalHash -ne $pinnedHash -or
        $existing.database -ne $database -or $existing.users -ne $users) {
        throw 'The existing manifest belongs to another ShadowBot installation.'
    }
    $existing
}

function Invoke-RuntimeControl($StateDirectory, $Install, [string[]]$Arguments) {
    $runtime = if ($Install.runtime -or $Install.runtimeRelease) { Get-InstallationRuntime $StateDirectory $Install } else { $StateDirectory }
    $previousHome = $env:SHADOWBOT_PI_HOME
    $previousSwitch = $env:SHADOWBOT_SWITCH_HOME
    try {
        $env:SHADOWBOT_PI_HOME = $StateDirectory
        $env:SHADOWBOT_SWITCH_HOME = $StateDirectory
        & (Join-Path $runtime 'node.exe') (Join-Path $runtime 'service/control.js') @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Harness operation failed: $($Arguments -join ' ')" }
    } finally {
        $env:SHADOWBOT_PI_HOME = $previousHome
        $env:SHADOWBOT_SWITCH_HOME = $previousSwitch
    }
}

function Copy-LegacyState {
    Assert-HostStopped
    $legacyOriginal = Join-Path $legacy 'original/opencode.exe'
    if ((Get-FileHash -LiteralPath $legacyOriginal).Hash -ne $pinnedHash) { throw 'Legacy original backup checksum mismatch.' }
    $legacyMode = (Get-Content -LiteralPath (Join-Path $legacy 'backend.json') -Raw | ConvertFrom-Json).mode
    if ($legacyMode -notin 'original', 'observe', 'pi') { throw 'Invalid legacy backend mode.' }
    if ($legacyMode -eq 'observe') { $legacyMode = 'original' }

    New-Item -ItemType Directory -Force -Path (Split-Path $original), (Join-Path $state 'agent') | Out-Null
    Set-CheckedExecutable $legacyOriginal $original $pinnedHash
    $legacyBackends = Join-Path $legacy 'backends'
    if (Test-Path -LiteralPath $legacyBackends) { Copy-Item -LiteralPath $legacyBackends -Destination $state -Recurse -Force }
    $legacyAgent = Join-Path $legacy 'agent'
    if (Test-Path -LiteralPath $legacyAgent) {
        foreach ($file in (Get-ChildItem -LiteralPath $legacyAgent -Recurse -File -Force)) {
            $relative = [IO.Path]::GetRelativePath($legacyAgent, $file.FullName)
            $destination = Join-Path $state "agent/$relative"
            if (!(Test-Path -LiteralPath $destination)) {
                New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
                Copy-Item -LiteralPath $file.FullName -Destination $destination
            }
        }
    }
    Write-AtomicJson $mode @{ mode = $legacyMode }
}

if ((Get-Item -LiteralPath $hostExe).VersionInfo.ProductVersion -ne $supportedVersion) {
    throw "Unsupported ShadowBot version. Expected $supportedVersion."
}

Invoke-InstallationLock $agentExe {
    if (Test-Path -LiteralPath (Join-Path $state 'activation.pending.json')) {
        Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
        Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    }
    $projectInstall = Read-Installation $state
    # Preparation writes only a new immutable release. Selection changes after validation.
    if ($spec.kind -eq 'managed') {
        if ($projectInstall -and $projectInstall.harnesses -and $projectInstall.harnesses[$Harness] -and !$projectInstall.harnesses[$Harness].legacy -and !$Update) {
            $release = $projectInstall
            Write-Host "复用已安装的 $Harness $($release.harnesses[$Harness].version)。"
        } else {
            Write-Host "正在准备 $Harness 运行时，下载和编译期间可以继续使用影刀…"
            $toolchain = Initialize-Toolchain $project
            $release = New-RuntimeRelease $project $state $toolchain $spec $projectInstall @{ agentPath = $agentExe; originalHash = $pinnedHash; database = $database; users = $users; resources = $resources; hostSkills = $hostSkills }
        }
    }
    Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
    Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    $projectInstall = Read-Installation $state
    $activeHash = (Get-FileHash -LiteralPath $agentExe).Hash
    $activeHome = $null
    $activeInstall = $null
    if ($activeHash -ne $pinnedHash) {
        if (!(Test-Path -LiteralPath $locator)) { throw 'Active OpenCode is neither the bundled binary nor a recognized launcher.' }
        $activeHome = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
        if ($activeHome -notin $state, $legacy) { throw '此影刀安装由其他项目目录管理。如果移动了本项目，请运行 .\switch.ps1 repair。' }
        Complete-Activation $activeHome $agentExe $pinnedHash ${function:Assert-HostStopped}
        $activeHash = (Get-FileHash -LiteralPath $agentExe).Hash
        $activeInstall = Read-Installation $activeHome
        if ($activeHash -ne $activeInstall.launcherHash) { throw 'Active launcher checksum mismatch.' }
    }

    $migrateLegacy = $activeHome -eq $legacy
    if (!$activeHome -and !(Test-Path -LiteralPath $mode) -and (Read-Installation $legacy)) {
        $legacyMode = (Get-Content -LiteralPath (Join-Path $legacy 'backend.json') -Raw | ConvertFrom-Json).mode
        if ($legacyMode -eq 'pi' -or (Test-Path -LiteralPath (Join-Path $legacy 'switch.pending.json'))) {
            throw 'The legacy state does not match the bundled OpenCode. Recover the legacy installation first.'
        }
        $migrateLegacy = $true
    }
    if (!$activeHome -and (Test-Path -LiteralPath $mode) -and
        ((Get-SelectedHarness $state $project) -ne $bundled.id -or
            (Test-Path -LiteralPath (Join-Path $state 'switch.pending.json')))) {
        throw 'The project session state does not match the bundled OpenCode.'
    }

    if ($spec.kind -eq 'bundled') {
        if ($activeInstall) {
            Invoke-RuntimeControl $activeHome $activeInstall @('backend', $Harness) | Out-Host
        }
        if ($migrateLegacy) { Copy-LegacyState }
        if ($activeInstall) {
            Set-CheckedExecutable $original $agentExe $pinnedHash $activeHash ${function:Assert-HostStopped}
        }
        if (Test-Path -LiteralPath $locator) {
            $owner = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
            if ($owner -in $state, $legacy) { Remove-Item -LiteralPath $locator -Force }
        }
        Write-Output "Active harness: $Harness ($($spec.version))"
        return
    }

    if (!(Test-Path -LiteralPath $database)) { throw 'Open ShadowBot Copilot once to initialize its session database, then exit ShadowBot.' }
    if ($activeHome -and (Test-Path -LiteralPath (Join-Path $activeHome 'switch.pending.json'))) {
        $current = (Get-Content -LiteralPath (Join-Path $activeHome 'backend.json') -Raw | ConvertFrom-Json).mode
        $recovery = if ($current -eq 'observe') { $bundled.id } else { $current }
        Invoke-RuntimeControl $activeHome $activeInstall @('backend', $recovery) | Out-Host
    }
    Assert-HostStopped
    if ($migrateLegacy) { Copy-LegacyState }
    if (!(Test-Path -LiteralPath $original)) {
        if ($activeHash -ne $pinnedHash) { throw 'Original OpenCode backup is missing.' }
        New-Item -ItemType Directory -Force -Path (Split-Path $original) | Out-Null
        Set-CheckedExecutable $agentExe $original $pinnedHash
    }
    if (!(Test-Path -LiteralPath $mode)) { Write-AtomicJson $mode @{ mode = $bundled.id } }
    New-Item -ItemType Directory -Force -Path (Join-Path $state 'agent'), (Join-Path $state 'skills') | Out-Null
    $runtime = Get-InstallationRuntime $state $release
    if ((& (Join-Path $runtime 'launcher.exe') --version | Out-String).Trim() -ne '1.18.12') { throw 'Launcher protocol mismatch.' }
    Write-AtomicJson (Join-Path $state 'prepared.json') $release
    Invoke-RuntimeControl $state $release @('verify-install', $Harness) | Out-Host
    Assert-HostStopped
    $journal = @{ previousHash = $activeHash; release = $release }
    if ($Update -and (Get-SelectedHarness $state $project) -eq $bundled.id) { $journal.bundledMode = $bundled.id }
    Write-AtomicJson (Join-Path $state 'activation.pending.json') $journal
    Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    if ($Update) {
        # The host caches command files when Copilot connects. Publish menus while
        # it is still stopped, rather than waiting for the first chat request.
        try { Invoke-RuntimeControl $state $release @('reload') | Out-Host }
        catch {
            $global:LASTEXITCODE = 0
            Write-Warning '运行时已更新，但菜单同步失败。检查命令目录权限和配置后运行 .\switch.ps1 reload。'
        }
        Write-Output "已更新 $Harness $($release.harnesses[$Harness].version)，当前继续使用 $(Get-SelectedHarness $state)。"
        return
    }
    Invoke-RuntimeControl $state $release @('backend', $Harness) | Out-Host
    Write-Output "Active harness: $Harness ($($release.harnesses[$Harness].version))"
    Write-Output "Project state: $state"
}
