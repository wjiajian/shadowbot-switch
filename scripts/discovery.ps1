param([string]$InspectInstallation, [string]$SelectedHarness)

function Resolve-ShadowBotDirectories([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $directory = [Environment]::ExpandEnvironmentVariables($candidate.Trim().Trim('"'))
        if (![IO.Path]::IsPathFullyQualified($directory)) { continue }
        if (Test-Path -LiteralPath (Join-Path $directory 'ShadowBot.exe') -PathType Leaf -ErrorAction SilentlyContinue) {
            (Resolve-Path -LiteralPath $directory).Path
        }
    }
}

# Every directory that looks like a ShadowBot installation, without asking anything.
# The recorded installation wins; the registry comes before Start menu shortcuts.
function Get-ShadowBotDirectoryCandidates([string]$ManifestPath) {
    if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
        $previous = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        if ($previous.agentPath) {
            $recorded = Resolve-ShadowBotDirectories (Split-Path (Split-Path $previous.agentPath))
            if ($recorded) { return $recorded }
        }
    }

    $uninstallKeys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $displayName = '^(影刀|ShadowBot)(?:\s*RPA)?$'
    $registered = foreach ($entry in (Get-ItemProperty -Path $uninstallKeys -ErrorAction SilentlyContinue)) {
        if ($entry.DisplayName -notmatch $displayName) { continue }
        $entry.InstallLocation
        if ($entry.DisplayIcon -match '^\s*"?(.+?[\\/]ShadowBot\.exe)"?\s*(?:,\s*-?\d+)?\s*$') {
            Split-Path $Matches[1]
        }
    }
    $directories = @(Resolve-ShadowBotDirectories $registered | Sort-Object -Unique)
    if (!$directories.Count) {
        $shortcuts = foreach ($folderName in 'Programs', 'CommonPrograms') {
            $folder = [Environment]::GetFolderPath($folderName)
            if (!$folder) { continue }
            Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
                Where-Object BaseName -Match $displayName
        }
        if ($shortcuts) {
            try {
                $shell = New-Object -ComObject WScript.Shell
                $targets = foreach ($file in $shortcuts) {
                    $target = $shell.CreateShortcut($file.FullName).TargetPath
                    if ([IO.Path]::GetFileName($target) -eq 'ShadowBot.exe') { Split-Path $target }
                }
                $directories = @(Resolve-ShadowBotDirectories $targets | Sort-Object -Unique)
            } catch {
                Write-Verbose "Could not read ShadowBot shortcuts: $_"
            }
        }
    }
    $directories
}

function Find-ShadowBotDirectory([string]$ManifestPath) {
    $directories = @(Get-ShadowBotDirectoryCandidates $ManifestPath)
    if ($directories.Count -gt 1) {
        if ([Console]::IsInputRedirected) { throw "找到多个影刀安装：$($directories -join ', ')。使用 --shadowbot-dir 指定路径。" }
        for ($i = 0; $i -lt $directories.Count; $i++) {
            $version = (Get-Item -LiteralPath (Join-Path $directories[$i] 'ShadowBot.exe')).VersionInfo.ProductVersion
            Write-Host "$($i + 1). $($directories[$i])（版本 $version）"
        }
        $selection = Read-Host '选择影刀安装编号'
        if ($selection -notmatch '^\d+$' -or [int]$selection -lt 1 -or [int]$selection -gt $directories.Count) { throw '无效安装编号。' }
        return $directories[[int]$selection - 1]
    }
    $directories | Select-Object -First 1
}

$script:MinShadowBotVersion = '6.3.39'

function Resolve-ShadowBotAgent {
    [CmdletBinding()]
    param([string]$ShadowBotDirectory)
    $hostVersion = (Get-Item -ErrorAction Stop -LiteralPath (Join-Path $ShadowBotDirectory 'ShadowBot.exe')).VersionInfo.ProductVersion
    $version = $hostVersion -as [version]
    if ($version -and $version -lt [version]$script:MinShadowBotVersion) {
        Write-Warning "影刀版本 $hostVersion 低于 $script:MinShadowBotVersion，可能不兼容。"
    }
    $candidates = foreach ($dir in (Get-ChildItem -LiteralPath $ShadowBotDirectory -Filter 'shadowbot-*' -Directory)) {
        $path = Join-Path $dir.FullName 'opencode.exe'
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $suffix = $dir.Name.Substring('shadowbot-'.Length)
        $rank = if ($suffix -eq $hostVersion) { 2 }
            elseif ($hostVersion -and $suffix -and ($suffix.StartsWith($hostVersion) -or $hostVersion.StartsWith($suffix))) { 1 }
            else { 0 }
        [pscustomobject]@{ path = $path; rank = $rank; version = $suffix -as [version] }
    }
    $agent = $candidates | Sort-Object rank,version,path -Descending | Select-Object -First 1
    if (!$agent) { throw "在 $ShadowBotDirectory 中没有找到 shadowbot-*/opencode.exe" }
    @{ hostVersion = $hostVersion; agentPath = $agent.path; resources = Join-Path (Split-Path $agent.path) 'Resources' }
}

function Test-ShadowBotPathEqual($Left, $Right) {
    if (!$Left -or !$Right) { return $false }
    [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Left)) -eq [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Right))
}

function Get-ShadowBotLocatorHome($Locator) {
    $owner = (Get-Content -Raw -LiteralPath $Locator -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop).home
    if ($owner -isnot [string] -or ![IO.Path]::IsPathFullyQualified($owner)) { throw '启动器定位文件缺少有效的安装目录。' }
    [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($owner))
}

function Get-ShadowBotAttachment($State, $RecordedPath, $Selected, $Bundled = 'original') {
    try {
        $RecordedPath = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($RecordedPath))
        $hostAgent = Resolve-ShadowBotAgent (Split-Path (Split-Path $RecordedPath)) -WarningAction SilentlyContinue
        $path = $hostAgent.agentPath
        $locator = "$path.shadowbot-pi.json"
        $attached = 'bundled'
        if (Test-Path -LiteralPath $locator) {
            try { $attached = if (Test-ShadowBotPathEqual (Get-ShadowBotLocatorHome $locator) $State) { 'managed' } else { 'other' } }
            catch { $attached = 'invalid' }
        }
        $action = $null
        $hint = if ($attached -eq 'other') {
            $action = 'repair'
            '当前启动器指向其他项目目录。如果移动了本项目，请退出影刀后运行 repair。'
        } elseif (!(Test-ShadowBotPathEqual $path $RecordedPath)) {
            $action = 'use'
            "影刀 $($hostAgent.hostVersion) 的当前程序在 $path，安装记录仍指向 $RecordedPath。退出影刀后运行 .\switch.ps1 use $Selected --wait。"
        } elseif ($attached -eq 'invalid') {
            $action = 'repair'
            '当前启动器定位文件已损坏或无效。退出影刀后运行 repair。'
        } elseif (($Selected -ne $Bundled) -ne ($attached -eq 'managed')) {
            $action = 'use'
            "当前影刀目录的启动器与所选后端不匹配。退出影刀后运行 .\switch.ps1 use $Selected --wait。"
        }
        @{ hostVersion = $hostAgent.hostVersion; agentPath = $path; recordedPath = $RecordedPath; attachment = $attached; warning = $hint; action = $action }
    } catch {
        @{ recordedPath = $RecordedPath; attachment = 'unknown'; warning = '无法确认当前影刀程序。检查影刀安装目录及启动器定位文件。' }
    }
}

if ($InspectInstallation) {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $install = Get-Content -Raw -LiteralPath (Join-Path $InspectInstallation 'install.json') | ConvertFrom-Json
    Get-ShadowBotAttachment $InspectInstallation $install.agentPath $SelectedHarness ($install.bundled.id ?? 'original') | ConvertTo-Json -Compress
}
