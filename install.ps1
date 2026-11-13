#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ShadowBotDirectory,
    [ValidateSet('pi', 'opencode-origin')][string]$Harness,
    [switch]$Update,
    [switch]$Wait,
    [ValidateRange(1, 86400)][int]$WaitTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/activation.ps1')
. (Join-Path $PSScriptRoot 'scripts/discovery.ps1')
. (Join-Path $PSScriptRoot 'scripts/toolchain.ps1')
. (Join-Path $PSScriptRoot 'scripts/processes.ps1')

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
    Write-Host '1. Pi（启用 Pi）'
    Write-Host '2. 影刀原版（恢复原聊天记录）'
    $Harness = switch (Read-Host '选择后端') {
        { $_ -in '1', 'pi' } { 'pi'; break }
        { $_ -in '2', 'opencode-origin' } { 'opencode-origin'; break }
        default { throw 'Select pi or opencode-origin.' }
    }
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
    $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($existing.agentPath -ne $agentExe -or $existing.originalHash -ne $pinnedHash -or
        $existing.database -ne $database -or $existing.users -ne $users) {
        throw 'The existing manifest belongs to another ShadowBot installation.'
    }
    $existing
}

function Remove-ProjectStage($Path) {
    if (!(Test-Path -LiteralPath $Path)) { return }
    $target = (Resolve-Path -LiteralPath $Path).Path
    if ($target -ne $Path -or !$target.StartsWith("$state\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unexpected installation staging directory.'
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}

function New-RuntimeRelease($Toolchain, $PiVersion) {
    $skillSources = Join-Path $project 'skills'
    $inputs = @((Get-ChildItem -File -Recurse -LiteralPath @(
        (Join-Path $project 'launcher'), (Join-Path $project 'src'), $skillSources
    )).FullName)
    $inputs += @('package.json', 'package-lock.json', 'go.mod', 'go.sum', 'tsconfig.json', 'contract/schema.sql', 'scripts/toolchain.ps1', 'install.ps1' | ForEach-Object { Join-Path $project $_ })
    $fingerprint = @($Toolchain.nodeHash, $PiVersion) + @(foreach ($path in ($inputs | Sort-Object)) {
        "$([IO.Path]::GetRelativePath($project, $path)) $((Get-FileHash -LiteralPath $path).Hash)"
    })
    $id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($fingerprint -join "`n")))).ToLowerInvariant()
    $release = Get-ReleasePath $state $id $PiVersion
    if (!(Test-Path -LiteralPath $release)) {
        Build-Bridge $project $Toolchain -SkipTests
        $stage = "$release.$PID.tmp"
        $service = Join-Path $stage 'service'
        New-Item -ItemType Directory -Force -Path $service, (Join-Path $stage 'skills') | Out-Null
        try {
            Copy-Item -LiteralPath (Join-Path $project 'dist/opencode.exe') -Destination (Join-Path $stage 'launcher.exe')
            Copy-Item -LiteralPath $Toolchain.node -Destination (Join-Path $stage 'node.exe')
            Copy-Item -LiteralPath (Join-Path $project 'contract/schema.sql') -Destination $stage
            Copy-Item -LiteralPath (Join-Path $project 'package.json'), (Join-Path $project 'package-lock.json') -Destination $stage
            Invoke-ProjectNpm $Toolchain $stage @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') | Out-Host
            Get-ChildItem -LiteralPath (Join-Path $project 'dist/service') -File -Filter '*.js' | Copy-Item -Destination $service
            Get-ChildItem -LiteralPath $skillSources -Directory | Copy-Item -Destination (Join-Path $stage 'skills') -Recurse
            [IO.Directory]::Move($stage, $release)
        } finally {
            Remove-ProjectStage $stage
        }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $release 'node.exe')).Hash -ne $Toolchain.nodeHash) { throw 'Runtime Node checksum mismatch.' }
    @{
        agentPath = $agentExe; originalHash = $pinnedHash; launcherHash = (Get-FileHash -LiteralPath (Join-Path $release 'launcher.exe')).Hash
        runtimeRelease = $id; piVersion = $PiVersion; database = $database; users = $users; resources = $resources; hostSkills = $hostSkills
    }
}

function Invoke-RuntimeControl($StateDirectory, $Install, [string[]]$Arguments) {
    $runtime = if ($Install.runtimeRelease) { Get-ReleasePath $StateDirectory $Install.runtimeRelease $Install.piVersion } else { $StateDirectory }
    $previousHome = $env:SHADOWBOT_PI_HOME
    $previousPi = $env:PI_CODING_AGENT_DIR
    try {
        $env:SHADOWBOT_PI_HOME = $StateDirectory
        $env:PI_CODING_AGENT_DIR = Join-Path $StateDirectory 'agent'
        & (Join-Path $runtime 'node.exe') (Join-Path $runtime 'service/control.js') @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Harness operation failed: $($Arguments -join ' ')" }
    } finally {
        $env:SHADOWBOT_PI_HOME = $previousHome
        $env:PI_CODING_AGENT_DIR = $previousPi
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
    $projectInstall = Read-Installation $state
    $restoreOriginalAfterUpdate = $Update -and (Test-Path -LiteralPath $mode) -and (Get-Content -LiteralPath $mode -Raw | ConvertFrom-Json).mode -ne 'pi'
    # Preparation only writes a new immutable release; the active process keeps its own dependencies.
    if ($Harness -eq 'pi') {
        if ($projectInstall -and !$Update) {
            $release = $projectInstall
            $piVersion = $release.piVersion
            Write-Host "复用已安装的 Pi $piVersion。运行 switch.ps1 update 应用当前源码。"
        } else {
            Write-Host '正在准备源码运行时，下载和编译期间可以继续使用影刀…'
            $toolchain = Initialize-Toolchain $project
            $piVersion = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).dependencies.'@earendil-works/pi-coding-agent'
            $release = New-RuntimeRelease $toolchain $piVersion
        }
    }
    Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
    Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    $projectInstall = Read-Installation $state
    if ($Harness -eq 'pi' -and !$Update -and $projectInstall) { $release = $projectInstall; $piVersion = $release.piVersion }
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
        ((Get-Content -LiteralPath $mode -Raw | ConvertFrom-Json).mode -eq 'pi' -or
            (Test-Path -LiteralPath (Join-Path $state 'switch.pending.json')))) {
        throw 'The project session state does not match the bundled OpenCode.'
    }

    if ($Harness -eq 'opencode-origin') {
        if ($activeInstall) {
            Invoke-RuntimeControl $activeHome $activeInstall @('backend', 'original') | Out-Host
        }
        if ($migrateLegacy) { Copy-LegacyState }
        if ($activeInstall) {
            Set-CheckedExecutable $original $agentExe $pinnedHash $activeHash ${function:Assert-HostStopped}
        }
        if (Test-Path -LiteralPath $locator) {
            $owner = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
            if ($owner -in $state, $legacy) { Remove-Item -LiteralPath $locator -Force }
        }
        Write-Output 'Active harness: opencode-origin (bundled OpenCode 1.18.12)'
        return
    }

    if (!(Test-Path -LiteralPath $database)) { throw 'Open ShadowBot Copilot once to initialize its session database, then exit ShadowBot.' }
    if ($activeHome -and (Test-Path -LiteralPath (Join-Path $activeHome 'switch.pending.json'))) {
        $current = (Get-Content -LiteralPath (Join-Path $activeHome 'backend.json') -Raw | ConvertFrom-Json).mode
        $recovery = if ($current -eq 'pi') { 'pi' } else { 'original' }
        Invoke-RuntimeControl $activeHome $activeInstall @('backend', $recovery) | Out-Host
    }
    Assert-HostStopped
    if ($migrateLegacy) { Copy-LegacyState }
    if (!(Test-Path -LiteralPath $original)) {
        if ($activeHash -ne $pinnedHash) { throw 'Original OpenCode backup is missing.' }
        New-Item -ItemType Directory -Force -Path (Split-Path $original) | Out-Null
        Set-CheckedExecutable $agentExe $original $pinnedHash
    }
    if (!(Test-Path -LiteralPath $mode)) { Write-AtomicJson $mode @{ mode = 'original' } }
    New-Item -ItemType Directory -Force -Path (Join-Path $state 'agent'), (Join-Path $state 'skills') | Out-Null
    $runtime = Get-ReleasePath $state $release.runtimeRelease $release.piVersion
    if ((& (Join-Path $runtime 'launcher.exe') --version | Out-String).Trim() -ne '1.18.12') { throw 'Launcher protocol mismatch.' }
    Write-AtomicJson (Join-Path $state 'prepared.json') $release
    Invoke-RuntimeControl $state $release @('verify-install') | Out-Host
    Assert-HostStopped
    if ($activeHome -ne $state -or $activeHash -ne $release.launcherHash -or $projectInstall.runtimeRelease -ne $release.runtimeRelease) {
        Write-AtomicJson (Join-Path $state 'activation.pending.json') @{ previousHash = $activeHash; release = $release }
        Complete-Activation $state $agentExe $pinnedHash ${function:Assert-HostStopped}
    }
    if ($restoreOriginalAfterUpdate) {
        Invoke-RuntimeControl $state $release @('backend', 'original') | Out-Host
        Set-CheckedExecutable $original $agentExe $pinnedHash $release.launcherHash ${function:Assert-HostStopped}
        if (Test-Path -LiteralPath $locator) { Remove-Item -LiteralPath $locator -Force }
        Write-Output "已更新 Pi $piVersion，当前继续使用影刀原版。"
        return
    }
    Invoke-RuntimeControl $state $release @('backend', 'pi') | Out-Host
    Write-Output "Active harness: pi ($piVersion)"
    Write-Output "Project state: $state"
}
