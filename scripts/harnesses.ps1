function Get-HarnessRegistry([string]$Project) {
    $names = @{}
    @(Get-ChildItem -LiteralPath (Join-Path $Project 'harnesses') -Directory | ForEach-Object {
        $spec = Get-Content -LiteralPath (Join-Path $_.FullName 'harness.json') -Raw | ConvertFrom-Json
        if ($spec.id -cnotmatch '^[a-z][a-z0-9-]{0,63}$' -or $spec.id -ne $_.Name -or $spec.id -eq 'observe' -or $spec.kind -notin 'managed', 'bundled') { throw 'Invalid harness registration.' }
        if (!$spec.name -or $null -eq $spec.aliases -or $spec.capabilities.skills -isnot [bool] -or $spec.capabilities.mcp -isnot [bool]) { throw 'Invalid harness capabilities or aliases.' }
        foreach ($name in @($spec.id) + @($spec.aliases)) {
            if ($name -cnotmatch '^[a-z][a-z0-9-]{0,63}$' -or $names.ContainsKey($name)) { throw 'Invalid or duplicate harness name.' }
            $names[$name] = $true
        }
        if ($spec.kind -eq 'managed') {
            foreach ($path in @($spec.adapter, $spec.launch.executable)) {
                if (!$path -or $path -match '[:\\]' -or @($path.Split('/') | Where-Object { $_ -in '', '.', '..' }).Count) { throw 'Invalid harness runtime path.' }
            }
            if ($null -eq $spec.launch.args) { throw 'Missing harness launch arguments.' }
        }
        $spec
    })
}

function Get-Harness([string]$Project, [string]$Name) {
    $registry = @(Get-HarnessRegistry $Project)
    $found = @($registry | Where-Object { $_.id -ceq $Name -or $_.aliases -ccontains $Name })
    if ($found.Count -ne 1) { throw "未知 harness：$Name。可用：$(($registry.id) -join ', ')" }
    $found[0]
}

function Get-SelectedHarness([string]$State) {
    $path = Join-Path $State 'backend.json'
    if (!(Test-Path -LiteralPath $path)) { return 'original' }
    $selected = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).mode
    if ($selected -eq 'observe') { return 'original' }
    $selected
}

function ConvertTo-HarnessInstallation($Install) {
    if (!$Install -or $Install.runtime) { return $Install }
    # Legacy metadata is translated once; all new writes use the neutral format.
    $copy = $Install | ConvertTo-Json -Depth 16 | ConvertFrom-Json -AsHashtable
    if ($Install.runtimeRelease -and $Install.piVersion) {
        $copy.runtime = @{ harness = 'pi'; release = $Install.runtimeRelease }
        $copy.harnesses = @{ pi = @{ release = $Install.runtimeRelease; version = $Install.piVersion; adapter = 'adapters/pi/index.js'; launch = @{ executable = 'node.exe'; args = @('{runtime}/service/main.js') }; capabilities = @{ skills = $true; mcp = $true } } }
        # A legacy release does not contain the new adapter module. It may be reused
        # for launch, but is rebuilt before being used by the new control service.
        $copy.harnesses.pi.legacy = $true
    }
    $copy
}

function Get-InstallationRuntime($State, $Install, [string]$Harness) {
    $record = if ($Harness -and $Install.harnesses) { $Install.harnesses[$Harness] } else { $null }
    if ($record) { return Get-ReleasePath $State $record.release '' $Harness }
    if ($Install.runtime) { return Get-ReleasePath $State $Install.runtime.release '' $Install.runtime.harness }
    Get-ReleasePath $State $Install.runtimeRelease $Install.piVersion
}
