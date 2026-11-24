#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ShadowBotDirectory,
    [string]$Harness,
    [switch]$Update, [switch]$Check, [switch]$All, [switch]$LocalOnly, [switch]$Pinned, [string]$HarnessVersion,
    [switch]$Wait,
    [ValidateRange(1, 86400)][int]$WaitTimeoutSeconds = 300,
    [ValidateSet('direct', 'aliyun')][string]$Mirror, [string]$OfflineToolchainDir, [switch]$Json
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

Assert-HarnessUpdateOptions $PSBoundParameters $Harness $null $Update
if ($Check) {
    $specs = if ($All) { Get-HarnessRegistry $project } else {
        if (!$Harness) { $Harness = Get-SelectedHarness $state $project }
        Get-Harness $project $Harness
    }
    $report = Get-HarnessUpdateReport $project $state $specs (Get-ToolchainSource $Mirror $OfflineToolchainDir)
    Write-HarnessUpdateReport $report -Json:$Json
    if (@($report.harnesses | Where-Object { $_.status -eq 'error' }).Count) { exit 1 }
    return
}
if (!$Harness -and $Update) { $Harness = Get-SelectedHarness $state $project }
if (!$Harness) {
    $registered = @(Get-HarnessRegistry $project)
    for ($i = 0; $i -lt $registered.Count; $i++) { Write-Host "$($i + 1). $($registered[$i].name) ($($registered[$i].id))" }
    $choice = Read-Host '选择 harness（编号或标识）'
    $Harness = if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $registered.Count) { $registered[[int]$choice - 1].id } else { $choice }
}
$spec = Get-Harness $project $Harness
$bundled = Get-BundledHarness $project
Assert-HarnessUpdateOptions $PSBoundParameters $Harness $spec $Update
$Harness = $spec.id
if ($Update -and $spec.kind -eq 'bundled') {
    Write-Output "$($spec.name) 随影刀一起更新，无需单独更新。"
    return
}

function Write-Step([string]$Text) { Write-Host "  $Text…" }
function Get-HarnessName([string]$Id) { try { (Get-Harness $project $Id).name } catch { $Id } }
if (!$ShadowBotDirectory) { $ShadowBotDirectory = Find-ShadowBotDirectory $manifest }
if (!$ShadowBotDirectory -and ![Console]::IsInputRedirected) { $ShadowBotDirectory = Read-Host '影刀安装目录（包含 ShadowBot.exe）' }
if (!$ShadowBotDirectory) { throw '没有找到影刀安装目录。请用 --shadowbot-dir 指定包含 ShadowBot.exe 的目录。' }
# Check before Resolve-Path and the version read, so a mistyped path gets a clear message.
$ShadowBotDirectory = $ShadowBotDirectory.Trim().Trim('"')
if (!(Test-Path -LiteralPath (Join-Path $ShadowBotDirectory 'ShadowBot.exe') -PathType Leaf)) {
    throw "在 $ShadowBotDirectory 中没有找到 ShadowBot.exe。请用 --shadowbot-dir 指定影刀安装目录（包含 ShadowBot.exe 的那个目录）。"
}

$shadowBot = (Resolve-Path -LiteralPath $ShadowBotDirectory).Path
$hostAgent = Resolve-ShadowBotAgent $shadowBot
$agentExe = $hostAgent.agentPath
$locator = "$agentExe.shadowbot-pi.json"
$resources = $hostAgent.resources
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
    if ((Split-Path -Leaf $existing.agentPath) -ne 'opencode.exe' -or (Split-Path (Split-Path $existing.agentPath)) -ne $shadowBot -or
        $existing.database -ne $database -or $existing.users -ne $users) {
        throw '本项目的安装记录属于另一个影刀安装目录，不能用于当前影刀。'
    }
    $existing
}

function Copy-LegacyState {
    Assert-HostStopped
    $legacyOriginal = Join-Path $legacy 'original/opencode.exe'
    if (!(Test-Path -LiteralPath $legacyOriginal -PathType Leaf)) { throw 'Legacy original backup is missing.' }
    $legacyMode = (Get-Content -LiteralPath (Join-Path $legacy 'backend.json') -Raw | ConvertFrom-Json).mode
    if ($legacyMode -notin 'original', 'observe', 'pi') { throw 'Invalid legacy backend mode.' }
    if ($legacyMode -eq 'observe') { $legacyMode = 'original' }

    New-Item -ItemType Directory -Force -Path (Split-Path $original), (Join-Path $state 'agent') | Out-Null
    Copy-Executable $legacyOriginal $original
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

function Install-SelectedHarness {
    $journalPath = Join-Path $state 'activation.pending.json'
    $pendingActivation = Test-Path -LiteralPath $journalPath
    if ($Update -and $pendingActivation) {
        # Plan against the release recovery will publish, before waiting for the host.
        $projectInstall = (Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json -AsHashtable).release
    } else {
        if ($pendingActivation) {
            Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
            Complete-Activation $state ${function:Assert-HostStopped}
        }
        $projectInstall = Read-Installation $state
    }
    # Preparation writes only a new immutable release. Selection changes after validation.
    if ($spec.kind -eq 'managed') {
        if ($projectInstall -and $projectInstall.harnesses -and $projectInstall.harnesses[$Harness] -and !$projectInstall.harnesses[$Harness].legacy -and !$Update) {
            $release = $projectInstall
            Write-Host "使用已安装的 $($spec.name) $($release.harnesses[$Harness].version)。"
        } else {
            $customSource = $env:SHADOWBOT_SWITCH_NODE_BASE_URL -or $env:SHADOWBOT_SWITCH_NPM_REGISTRY -or $env:SHADOWBOT_SWITCH_GO_BASE_URL -or $env:SHADOWBOT_SWITCH_GOPROXY
            if (!$Json -and !$customSource -and !$Mirror -and !$env:SHADOWBOT_SWITCH_MIRROR -and !$OfflineToolchainDir -and !$env:SHADOWBOT_SWITCH_OFFLINE_DIR -and ![Console]::IsInputRedirected) {
                do {
                    $choice = Read-Host '下载源 [1] 直连官方（默认） [2] 阿里云镜像'
                    if ($choice -notin '', '1', '2') { Write-Host '请选择 1 或 2。' }
                } until ($choice -in '', '1', '2')
                if ($choice -eq '2') { $Mirror = 'aliyun' }
            }
            $previous = ConvertTo-HarnessInstallation $projectInstall
            $record = if ($previous.harnesses) { $previous.harnesses[$Harness] }
            $source = Get-ToolchainSource $Mirror $OfflineToolchainDir
            $plan = Resolve-HarnessUpdatePlan $project $state $spec $record $source -Update:$Update -PreferLatest:(!$Update) -LocalOnly:$LocalOnly -Pinned:$Pinned -HarnessVersion $HarnessVersion
            Write-Host $plan.summary
            if ($Update -and $pendingActivation) {
                Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
                Complete-Activation $state ${function:Assert-HostStopped}
                $projectInstall = Read-Installation $state
            }
            $owner = if (Test-Path -LiteralPath $locator) { (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home }
            if ($Update -and $projectInstall.agentPath -eq $agentExe -and
                (($owner -eq $state) -or (!$owner -and (Get-SelectedHarness $state $project) -eq $bundled.id)) -and $record.release -and !$record.legacy -and !$plan.needsLock -and
                [bool]$record.dependencies.explicit -eq [bool]$plan.explicit -and
                !(Test-Path -LiteralPath (Join-Path $state 'switch.pending.json')) -and
                (Get-RuntimeReleaseId $project $spec (Get-ToolchainNodeHash) $plan.version $plan) -eq $record.release -and
                (Test-Path -LiteralPath (Get-ReleasePath $state $record.release '' $Harness) -PathType Container)) {
                Write-Output "$($spec.name) 已是最新（$($plan.version)），本地源码没有变化，无需重建。"
                return
            }
            Write-Host "正在$(if ($Update) { '更新' } else { '安装' }) $($spec.name)，期间可以继续使用影刀…"
            Write-Step '准备构建工具'
            $toolchain = Initialize-Toolchain $project $Mirror $OfflineToolchainDir
            if ($plan.needsLock) {
                Write-Step '解析依赖版本'
                try { $plan = New-HarnessDependencyLock $project $state $toolchain $spec $plan.version -Explicit:$plan.explicit }
                catch {
                    if ($Update) { throw }
                    $plan = Read-HarnessBaseline $project $spec
                    Write-Warning "无法生成依赖锁（$($_.Exception.Message)），改用仓库锁定 $($plan.version)。"
                }
            }
            Write-Step '构建运行时'
            $release = New-RuntimeRelease $project $state $toolchain $spec $projectInstall @{ agentPath = $agentExe; bundledVersion = $projectInstall.bundled.version; database = $database; users = $users; resources = $resources; hostSkills = $hostSkills } $plan
        }
    }
    Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
    Complete-Activation $state ${function:Assert-HostStopped}
    $projectInstall = Read-Installation $state
    $activeHome = if (Test-Path -LiteralPath $locator) {
        $owner = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
        if ($owner -notin $state, $legacy) { throw '此影刀安装由其他项目目录管理。如果移动了本项目，请运行 .\switch.ps1 repair。' }
        $owner
    }
    $activeInstall = if ($activeHome) {
        Complete-Activation $activeHome ${function:Assert-HostStopped}
        Read-Installation $activeHome
    }

    $migrateLegacy = $activeHome -eq $legacy
    if (!$activeHome -and !(Test-Path -LiteralPath $mode) -and (Read-Installation $legacy)) {
        $legacyMode = (Get-Content -LiteralPath (Join-Path $legacy 'backend.json') -Raw | ConvertFrom-Json).mode
        if ($legacyMode -eq 'pi' -or (Test-Path -LiteralPath (Join-Path $legacy 'switch.pending.json'))) {
            throw 'The legacy state does not match the bundled OpenCode. Recover the legacy installation first.'
        }
        $migrateLegacy = $true
    }
    $upgraded = $projectInstall -and $projectInstall.agentPath -ne $agentExe
    if ($upgraded) {
        $oldAgent = $projectInstall.agentPath
        Write-Warning "检测到影刀已升级：$oldAgent → $agentExe，将重新备份原版。"
        $oldLocator = "$oldAgent.shadowbot-pi.json"
        if (Test-Path -LiteralPath $oldLocator) {
            $oldOwner = (Get-Content -LiteralPath $oldLocator -Raw | ConvertFrom-Json).home
            if ($oldOwner -in $state,$legacy) {
                if (Test-Path -LiteralPath $oldAgent) { Copy-Executable (Join-Path $oldOwner 'original/opencode.exe') $oldAgent -BeforeReplace ${function:Assert-HostStopped} }
                Remove-Item -LiteralPath $oldLocator
            }
        }
    }
    if ($spec.kind -eq 'bundled' -and $activeInstall) {
        Invoke-RuntimeControl $activeHome $activeInstall @('backend', $Harness) | Out-Host
    }
    if ($spec.kind -eq 'managed' -and $activeHome -and (Test-Path -LiteralPath (Join-Path $activeHome 'switch.pending.json'))) {
        $current = (Get-Content -LiteralPath (Join-Path $activeHome 'backend.json') -Raw | ConvertFrom-Json).mode
        $recovery = if ($current -eq 'observe') { $bundled.id } else { $current }
        Invoke-RuntimeControl $activeHome $activeInstall @('backend', $recovery) | Out-Host
    }
    if ($migrateLegacy) { Copy-LegacyState }
    $backup = Get-Item -LiteralPath $original -ErrorAction SilentlyContinue
    $agent = Get-Item -LiteralPath $agentExe
    if (!$activeHome -and (!$backup -or $upgraded -or $agent.Length -ne $backup.Length -or $agent.LastWriteTimeUtc -ne $backup.LastWriteTimeUtc)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $original) | Out-Null
        Copy-Executable $agentExe $original
    } elseif (!$backup) { throw 'Original OpenCode backup is missing.' }
    $bundledVersion = Get-OpenCodeVersion $original $bundled.version
    if ($spec.kind -eq 'bundled') {
        if ($projectInstall) {
            $projectInstall.agentPath = $agentExe
            $projectInstall.resources = $resources
            $projectInstall.bundled = @{ id = $bundled.id; version = $bundledVersion }
            Write-AtomicJson $manifest $projectInstall
            if (!$activeHome -and ((Get-SelectedHarness $state $project) -ne $bundled.id -or (Test-Path -LiteralPath (Join-Path $state 'switch.pending.json')))) {
                Invoke-RuntimeControl $state $projectInstall @('backend', $Harness) | Out-Host
            }
        }
        if ($activeInstall) { Copy-Executable $original $agentExe -BeforeReplace ${function:Assert-HostStopped} }
        if (Test-Path -LiteralPath $locator) {
            $owner = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home
            if ($owner -in $state, $legacy) { Remove-Item -LiteralPath $locator -Force }
        }
        Write-Output "已切换到 $($spec.name)。"
        return
    }

    if (!(Test-Path -LiteralPath $database)) { throw '请先打开一次影刀 Copilot（用来创建会话数据库），然后退出影刀再运行。' }
    Assert-HostStopped
    $release.agentPath = $agentExe
    $release.resources = $resources
    $release.bundled = @{ id = $bundled.id; version = $bundledVersion }
    if (!(Test-Path -LiteralPath $mode)) { Write-AtomicJson $mode @{ mode = $bundled.id } }
    New-Item -ItemType Directory -Force -Path (Join-Path $state 'agent'), (Join-Path $state 'skills') | Out-Null
    $runtime = Get-InstallationRuntime $state $release
    $version = (& (Join-Path $runtime 'launcher.exe') --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or !$version) { throw 'Launcher protocol mismatch.' }
    Write-AtomicJson (Join-Path $state 'prepared.json') $release
    Write-Step '检查安装'
    # The JSON report is for scripts; failures are explained on stderr.
    Invoke-RuntimeControl $state $release @('verify-install', $Harness) | Out-Null
    Assert-HostStopped
    Write-Step $(if ($Update) { '启用新版本' } else { '切换后端' })
    $journal = @{ release = $release }
    if ($Update -and (Get-SelectedHarness $state $project) -eq $bundled.id) { $journal.bundledMode = $bundled.id }
    Write-AtomicJson (Join-Path $state 'activation.pending.json') $journal
    Complete-Activation $state ${function:Assert-HostStopped}
    if ($Update) {
        # The host caches command files when Copilot connects. Publish menus while
        # it is still stopped, rather than waiting for the first chat request.
        # The menu then appears on the next start, so the summary is not shown.
        try { Invoke-RuntimeControl $state $release @('reload') | Out-Null }
        catch {
            $global:LASTEXITCODE = 0
            Write-Warning '已更新，但 Skill 菜单同步失败。检查命令目录权限后运行 .\switch.ps1 reload。'
        }
        Write-Output "已更新 $($spec.name) 到 $($release.harnesses[$Harness].version)，当前仍在使用 $(Get-HarnessName (Get-SelectedHarness $state $project))。"
        return
    }
    Invoke-RuntimeControl $state $release @('backend', $Harness) | Out-Host
    Write-Output "已切换到 $($spec.name) $($release.harnesses[$Harness].version)。"
}
Invoke-InstallationLock $project { Invoke-InstallationLock $agentExe ${function:Install-SelectedHarness} }
