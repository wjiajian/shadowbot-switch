. (Join-Path $PSScriptRoot 'activation.ps1')
. (Join-Path $PSScriptRoot 'processes.ps1')
. (Join-Path $PSScriptRoot 'runtime.ps1')

function Repair-InstallationLocator($State, $ExpectedOriginalHash, [scriptblock]$CheckStopped) {
    $manifest = Join-Path $State 'install.json'
    $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    if ($installation.originalHash -ne $ExpectedOriginalHash -or (Get-FileHash -LiteralPath (Join-Path $State 'original/opencode.exe')).Hash -ne $ExpectedOriginalHash) { throw '原程序备份校验失败，不能修复。' }
    $locator = "$($installation.agentPath).shadowbot-pi.json"
    if (Test-Path -LiteralPath $locator) {
        $oldState = (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json -AsHashtable).home
        if ($oldState -ne $State -and (Test-Path -LiteralPath $oldState)) { throw "原项目仍存在：$oldState。请从原项目操作，避免接管另一套会话。" }
    }
    & $CheckStopped
    Complete-Activation $State $installation.agentPath $ExpectedOriginalHash $CheckStopped
    $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    $runtime = Get-InstallationRuntime $State $installation
    if ((Get-FileHash -LiteralPath (Join-Path $runtime 'launcher.exe')).Hash -ne $installation.launcherHash) { throw '运行时启动器校验失败，不能修复。' }
    $active = (Get-FileHash -LiteralPath $installation.agentPath).Hash
    if ($active -ne $ExpectedOriginalHash -and $active -ne $installation.launcherHash) { throw '活动程序不属于此项目，不能修复定位。' }
    if ($active -ne $ExpectedOriginalHash) { Write-AtomicJson $locator @{ home = $State } }
    Publish-Release $State $installation
}

function Repair-ProjectLocation($Project, [string]$ShadowBotDirectory, [switch]$Wait, [int]$WaitTimeoutSeconds = 300,
    [ValidateSet('direct', 'aliyun')][string]$Mirror, [string]$OfflineToolchainDir, [switch]$Json) {
    $state = Join-Path $Project '.shadowbot-switch'
    $manifest = Join-Path $state 'install.json'
    if (!(Test-Path -LiteralPath $manifest)) { throw '缺少安装记录。请先运行 use <harness>；已有会话数据请保留。' }
    $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    if ($ShadowBotDirectory -and !(Test-Path -LiteralPath $ShadowBotDirectory -PathType Container)) { throw "指定的影刀目录不存在：$ShadowBotDirectory" }
    if ($ShadowBotDirectory -and [IO.Path]::TrimEndingDirectorySeparator((Split-Path (Split-Path $installation.agentPath))) -ne [IO.Path]::TrimEndingDirectorySeparator((Resolve-Path -LiteralPath $ShadowBotDirectory).Path)) {
        throw '搬迁修复只能用于原影刀安装；新设备请使用 config import。'
    }
    $pinnedHash = Get-BundledExecutableHash
    Invoke-InstallationLock $installation.agentPath {
        Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
        Repair-InstallationLocator $state $pinnedHash ${function:Assert-SwitchProcessesStopped}
    }
    $backend = (Get-Content -LiteralPath (Join-Path $state 'backend.json') -Raw | ConvertFrom-Json -AsHashtable).mode
    $harness = if ($backend -eq 'observe') { (Get-BundledHarness $Project).id } else { $backend }
    $options = @{}
    if ($Mirror) { $options.Mirror = $Mirror }
    & (Join-Path $Project 'install.ps1') @options -OfflineToolchainDir $OfflineToolchainDir -Json:$Json -Harness $harness -Wait:$Wait -WaitTimeoutSeconds $WaitTimeoutSeconds
    Write-Host '修复完成。如果配置里写了绝对路径，运行 .\switch.ps1 config check 检查是否还有效。'
}

function Restore-UninstallHost($State, $AgentExe, $PinnedHash, [switch]$Wait, [int]$WaitTimeoutSeconds) {
    $pending = Test-Path -LiteralPath (Join-Path $State 'activation.pending.json')
    if (!(Test-Path -LiteralPath $AgentExe -PathType Leaf)) {
        if ($pending) { throw "安装尚未完成，找不到影刀程序：$AgentExe。请先恢复影刀安装。" }
        Write-Host '影刀目录已不存在，跳过恢复原版'
        return
    }
    $locator = "$AgentExe.shadowbot-pi.json"
    $legacy = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ShadowBotPi'
    $owner = if (Test-Path -LiteralPath $locator) { (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home }
    $original = Join-Path $State 'original/opencode.exe'
    $project = Split-Path $State
    $bundled = (Get-BundledHarness $project).id
    $foreign = (Test-Path -LiteralPath $locator) -and $owner -notin $State, $legacy
    if ($foreign) {
        if ($owner -and !$pending -and !(Test-Path -LiteralPath (Join-Path $State 'switch.pending.json')) -and
            (Get-SelectedHarness $State $Project) -eq $bundled) {
            Write-Host '其他项目正在管理影刀，跳过恢复原版。'
            return
        }
        throw '活动程序不属于此项目，已停止卸载。如移动过项目，请先运行 .\switch.ps1 repair。'
    }
    if (!(Test-Path -LiteralPath $original -PathType Leaf) -or (Get-FileHash -LiteralPath $original).Hash -ne $PinnedHash) {
        throw '原程序备份缺失或校验失败，不能恢复原版。'
    }
    Wait-SwitchProcesses -Wait:$Wait -TimeoutSeconds $WaitTimeoutSeconds
    Complete-Activation $State $AgentExe $PinnedHash ${function:Assert-SwitchProcessesStopped}
    $install = Get-Content -LiteralPath (Join-Path $State 'install.json') -Raw | ConvertFrom-Json -AsHashtable
    if ($install.agentPath -ne $AgentExe -or $install.originalHash -ne $PinnedHash) { throw '安装记录校验失败。' }
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if ($install.database -ne (Join-Path $local 'ShadowBot/opencode/runtime/shared/xdg_data/opencode/opencode.db') -or
        $install.users -ne (Join-Path $local 'ShadowBot/users') -or
        $install.resources -ne (Join-Path (Split-Path $AgentExe) 'Resources')) { throw '安装记录中的影刀数据路径不匹配。' }
    $owner = if (Test-Path -LiteralPath $locator) { (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home }
    $active = (Get-FileHash -LiteralPath $AgentExe).Hash
    $managed = (Get-SelectedHarness $State $Project) -ne $bundled
    if ($active -ne $PinnedHash -or $managed -or (Test-Path -LiteralPath (Join-Path $State 'switch.pending.json'))) {
        if (($active -ne $PinnedHash -and $owner -ne $State) -or $active -notin $install.launcherHash, $PinnedHash) { throw '活动程序不属于此项目，已停止卸载。' }
        if ($active -eq $PinnedHash) {
            # Installed control versions require the verified launcher to switch sessions.
            $runtime = Get-InstallationRuntime $State $install
            Write-AtomicJson $locator @{ home = $State }
            Set-CheckedExecutable (Join-Path $runtime 'launcher.exe') $AgentExe $install.launcherHash $PinnedHash ${function:Assert-SwitchProcessesStopped}
        }
        Write-Host '正在恢复原版会话与 Skill 菜单…'
        Invoke-RuntimeControl $State $install @('backend', $bundled) | Out-Null
        Set-CheckedExecutable $original $AgentExe $PinnedHash $install.launcherHash ${function:Assert-SwitchProcessesStopped}
    }
    if ((Test-Path -LiteralPath $locator) -and (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home -in $State, $legacy) {
        Remove-Item -LiteralPath $locator -Force
    }
    $AgentExe
}

function Get-ProjectSwitchProcesses([string]$Project) {
    $prefix = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Project)) + [IO.Path]::DirectorySeparatorChar
    @(Get-Process -Name shadowbot-pi,node,go -ErrorAction SilentlyContinue | Where-Object {
        $_.Id -ne $PID -and $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Test-ForeignSwitchOwner([string]$Owner, [string]$State, [string]$TargetExe, [string]$BundledHash) {
    if (!$Owner -or ![IO.Path]::IsPathFullyQualified($Owner)) { return $false }
    $normalizedOwner = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Owner))
    $normalizedState = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($State))
    if ($normalizedOwner -eq $normalizedState -or !(Test-Path -LiteralPath $normalizedOwner -PathType Container)) { return $false }
    $ownerOriginal = Join-Path $normalizedOwner 'original/opencode.exe'
    if ((Test-Path -LiteralPath $ownerOriginal -PathType Leaf) -and (Get-FileHash -LiteralPath $ownerOriginal).Hash -eq $BundledHash) {
        return $true
    }
    $ownerManifest = Join-Path $normalizedOwner 'install.json'
    if (Test-Path -LiteralPath $ownerManifest -PathType Leaf) {
        try {
            $ownerInstall = Get-Content -LiteralPath $ownerManifest -Raw | ConvertFrom-Json
            if ($ownerInstall.agentPath -and [IO.Path]::IsPathFullyQualified($ownerInstall.agentPath) -and
                [IO.Path]::GetFullPath($ownerInstall.agentPath) -eq [IO.Path]::GetFullPath($TargetExe)) {
                return $true
            }
        } catch { }
    }
    $false
}

function Uninstall-Project($Project, [string]$ShadowBotDirectory, [switch]$Wait,
    [ValidateRange(1, 86400)][int]$WaitTimeoutSeconds = 300, [switch]$PurgeData, [switch]$Yes) {
    $state = Join-Path $Project '.shadowbot-switch'
    if ($PurgeData -and !$Yes) {
        if ([Console]::IsInputRedirected) { throw '--purge-data 需要 --yes 确认删除历史会话与配置。' }
        if ((Read-Host "永久删除 $state 中的历史会话与配置？输入 YES 确认") -cne 'YES') { throw '已取消卸载。' }
    }
    Invoke-InstallationLock $Project {
        if ($ShadowBotDirectory -and !(Test-Path -LiteralPath $ShadowBotDirectory -PathType Container)) { throw "指定的影刀目录不存在：$ShadowBotDirectory" }
        foreach ($parent in $state, (Join-Path $Project 'harnesses'), (Join-Path $state 'harnesses'), (Join-Path $state 'original')) {
            if ((Test-Path -LiteralPath $parent) -and (Get-Item -LiteralPath $parent -Force).LinkType) { throw "不能清理链接目录：$parent" }
        }
        $manifest = Join-Path $state 'install.json'
        $pending = Join-Path $state 'activation.pending.json'
        $agent = if (Test-Path -LiteralPath $manifest) { (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).agentPath }
            elseif (Test-Path -LiteralPath $pending) { (Get-Content -LiteralPath $pending -Raw | ConvertFrom-Json).release.agentPath }
        $restored = $null
        $keepOriginal = $false
        $bundledHash = Get-BundledExecutableHash
        if ((Test-Path -LiteralPath $manifest) -or (Test-Path -LiteralPath $pending)) {
            if (!$agent -or ![IO.Path]::IsPathFullyQualified($agent) -or (Split-Path -Leaf $agent) -ne 'opencode.exe') { throw '安装记录缺少有效的 opencode.exe 路径。' }
            if ($ShadowBotDirectory -and [IO.Path]::TrimEndingDirectorySeparator((Split-Path (Split-Path $agent))) -ne [IO.Path]::TrimEndingDirectorySeparator((Resolve-Path -LiteralPath $ShadowBotDirectory).Path)) {
                throw '指定的影刀目录与安装记录不一致。'
            }
            $restored = Invoke-InstallationLock $agent {
                Restore-UninstallHost $state $agent $bundledHash -Wait:$Wait -WaitTimeoutSeconds $WaitTimeoutSeconds
            }
            if (!$restored -and $PurgeData -and !(Test-Path -LiteralPath $agent -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $state 'original/opencode.exe') -PathType Leaf)) {
                $bundled = (Get-BundledHarness $Project).id
                if ((Get-SelectedHarness $state $Project) -ne $bundled) {
                    $keepOriginal = $true
                    Write-Warning "影刀程序不存在，为避免丢失原版备份已保留：$state\original"
                }
            }
        }
        elseif ($PurgeData -and (Test-Path -LiteralPath (Join-Path $state 'original/opencode.exe') -PathType Leaf)) {
            if (!$ShadowBotDirectory) { throw '缺少安装记录，请用 --shadowbot-dir 指定影刀目录以核验原版备份可以安全删除。' }
            $target = Join-Path (Resolve-Path -LiteralPath $ShadowBotDirectory).Path "shadowbot-$(Get-SupportedShadowBotVersion)/opencode.exe"
            $locator = "$target.shadowbot-pi.json"
            $owner = if (Test-Path -LiteralPath $locator) { (Get-Content -LiteralPath $locator -Raw | ConvertFrom-Json).home }
            $otherOwner = Test-ForeignSwitchOwner $owner $state $target $bundledHash
            if (!$otherOwner -and (!(Test-Path -LiteralPath $target -PathType Leaf) -or (Get-FileHash -LiteralPath $target).Hash -ne $bundledHash)) {
                throw '无法确认影刀已恢复原版，已保留原版备份。'
            }
        }
        $busy = @(Get-ProjectSwitchProcesses $Project)
        if ($busy.Count -and $Wait) {
            $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($WaitTimeoutSeconds, 15))
            while ($busy.Count -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 200
                $busy = @(Get-ProjectSwitchProcesses $Project)
            }
        }
        if ($busy.Count) { throw "请先关闭项目中的进程（若影刀正在运行请先退出影刀）：$($busy.Path -join '，')" }
        Write-Host '正在清理工具链和运行时…'
        $paths = @($manifest)
        foreach ($name in '.tools', 'dist', 'node_modules') { $paths += Join-Path $Project $name }
        $harnesses = Join-Path $Project 'harnesses'
        if (Test-Path -LiteralPath $harnesses) {
            foreach ($dir in Get-ChildItem -LiteralPath $harnesses -Directory) {
                if (!$dir.LinkType) { $paths += Join-Path $dir.FullName 'node_modules' }
            }
        }
        if ($PurgeData -and !$keepOriginal) { $paths += $state }
        else {
            if ($PurgeData) {
                foreach ($entry in Get-ChildItem -LiteralPath $state -Force) {
                    if ($entry.Name -ne 'original') { $paths += $entry.FullName }
                }
            } else {
                $runtimeHarnesses = Join-Path $state 'harnesses'
                if (Test-Path -LiteralPath $runtimeHarnesses) {
                    foreach ($dir in Get-ChildItem -LiteralPath $runtimeHarnesses -Directory -Force) {
                        if (!$dir.LinkType) { $paths += Join-Path $dir.FullName 'releases' }
                    }
                }
                if ($restored) { $paths += Join-Path $state 'original' }
                foreach ($name in 'releases', 'running', 'host-skills', 'shadowbot-pi.exe', 'backend.json', 'prepared.json', 'activation.pending.json', 'switch.pending.json') {
                    $paths += Join-Path $state $name
                }
            }
        }
        $failed = @()
        $removed = @(foreach ($path in ($paths | Select-Object -Unique)) {
            try {
                try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop }
                catch [System.Management.Automation.ItemNotFoundException] { continue }
                if ($item.LinkType) { throw '跳过链接，避免清理外部文件。' }
                Remove-Item -LiteralPath $path -Force -Recurse -ErrorAction Stop
                $path
            } catch { $failed += [pscustomobject]@{ path = $path; reason = $_.Exception.Message } }
        })
        $kept = @(if (Test-Path -LiteralPath $state) { Get-ChildItem -Force -LiteralPath $state | Select-Object -ExpandProperty FullName })
        [pscustomobject]@{ restored = $restored; removed = $removed; retained = $kept; failed = $failed }
    }
}
