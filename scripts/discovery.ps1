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

function Find-ShadowBotDirectory([string]$ManifestPath) {
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
