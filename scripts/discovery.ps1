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
        throw "Multiple ShadowBot installations found ($($directories -join ', ')). Choose one with -ShadowBotDirectory."
    }
    $directories | Select-Object -First 1
}
