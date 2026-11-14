function Remove-ProjectStage($State, $Path) {
    if (!(Test-Path -LiteralPath $Path)) { return }
    $target = (Resolve-Path -LiteralPath $Path).Path
    if ($target -ne $Path -or !$target.StartsWith("$state\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unexpected installation staging directory.'
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}

function New-RuntimeRelease($Project, $State, $Toolchain, $Spec, $Installed, $HostInstallation) {
    $adapterPackage = Join-Path $project "harnesses/$($Spec.id)/package.json"
    $adapterVersion = if ($Spec.versionPackage) { (Get-Content -LiteralPath $adapterPackage -Raw | ConvertFrom-Json -AsHashtable).dependencies[$Spec.versionPackage] } else { $Spec.version }
    if (!$adapterVersion) { throw 'Harness version is missing.' }
    $skillSources = Join-Path $project 'skills'
    $inputs = @((Get-ChildItem -File -Recurse -LiteralPath @(
        (Join-Path $project 'launcher'), (Join-Path $project 'src'), (Join-Path $project 'harnesses'), (Join-Path $project 'scripts'), $skillSources
    ) | Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' }).FullName)
    $inputs += @('package.json', 'package-lock.json', 'go.mod', 'go.sum', 'tsconfig.json', 'contract/schema.sql', 'scripts/toolchain.ps1', 'install.ps1' | ForEach-Object { Join-Path $project $_ })
    $fingerprint = @($Toolchain.nodeHash, $Spec.id, $adapterVersion) + @(foreach ($path in ($inputs | Sort-Object)) {
        "$([IO.Path]::GetRelativePath($project, $path)) $((Get-FileHash -LiteralPath $path).Hash)"
    })
    $id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($fingerprint -join "`n")))).ToLowerInvariant()
    $release = Get-ReleasePath $state $id '' $Spec.id
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
            Invoke-ProjectNpm $Toolchain $stage @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
            Get-ChildItem -LiteralPath (Join-Path $project 'dist/service') | Copy-Item -Destination $service -Recurse
            foreach ($registration in (Get-HarnessRegistry $project)) {
                $registryTarget = Join-Path $stage "harnesses/$($registration.id)"
                New-Item -ItemType Directory -Force -Path $registryTarget | Out-Null
                Copy-Item -LiteralPath (Join-Path $project "harnesses/$($registration.id)/harness.json") -Destination $registryTarget
            }
            if (Test-Path -LiteralPath $adapterPackage) {
                $adapterDirectory = Join-Path $service (Split-Path $Spec.adapter)
                New-Item -ItemType Directory -Force -Path $adapterDirectory | Out-Null
                Copy-Item -LiteralPath $adapterPackage, (Join-Path (Split-Path $adapterPackage) 'package-lock.json') -Destination $adapterDirectory
                Invoke-ProjectNpm $Toolchain $adapterDirectory @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
            }
            Get-ChildItem -LiteralPath $skillSources -Directory | Copy-Item -Destination (Join-Path $stage 'skills') -Recurse
            $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
            $resolvedRelease = [IO.Path]::GetFullPath($release)
            $statePrefix = [IO.Path]::GetFullPath($State).TrimEnd('\') + '\'
            if (!$resolvedStage.StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase) -or !$resolvedRelease.StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime publication escaped the installation directory.' }
            [IO.Directory]::Move($stage, $release)
        } finally {
            Remove-ProjectStage $state $stage
        }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $release 'node.exe')).Hash -ne $Toolchain.nodeHash) { throw 'Runtime Node checksum mismatch.' }
    $records = @{}
    $previous = ConvertTo-HarnessInstallation $Installed
    if ($previous.harnesses) { foreach ($key in $previous.harnesses.Keys) { $records[$key] = $previous.harnesses[$key] } }
    $records[$Spec.id] = @{ release = $id; version = $adapterVersion; adapter = $Spec.adapter; launch = $Spec.launch; capabilities = $Spec.capabilities }
    $bundled = Get-BundledHarness $Project
    Add-LegacyManifestFields @{
        format = 2; agentPath = $HostInstallation.agentPath; originalHash = $HostInstallation.originalHash; launcherHash = (Get-FileHash -LiteralPath (Join-Path $release 'launcher.exe')).Hash
        runtime = @{ harness = $Spec.id; release = $id }; harnesses = $records
        bundled = @{ id = $bundled.id; version = $bundled.version }
        database = $HostInstallation.database; users = $HostInstallation.users; resources = $HostInstallation.resources; hostSkills = $HostInstallation.hostSkills
    }
}
