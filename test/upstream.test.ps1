$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot
. (Join-Path $repository 'scripts/activation.ps1')
. (Join-Path $repository 'scripts/runtime.ps1')

function Assert-Rejected([scriptblock]$Action,$Pattern) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        return
    }
    throw "Expected rejection: $Pattern"
}
foreach ($bad in 'v1.0.0','1.0','01.0.0','1.0.0-','1.0.0 --registry=x',('1' * 65),'1.0.0-alpha.01') {
    Assert-Rejected { Assert-SemVer $bad } '版本号无效'
}
$order = '1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0','1.0.100000000000000000000'
for ($i = 1; $i -lt $order.Count; $i++) {
    if ((Compare-SemVer $order[$i] $order[$i-1]) -le 0) { throw "SemVer precedence failed at $i" }
}
if ((Compare-SemVer '1.2.3+abc' '1.2.3+def') -ne 0 -or (Test-SemVerCompatible '0.2.1' '0.1.5') -or !(Test-SemVerCompatible '0.1.7' '0.1.3')) { throw 'SemVer compatibility failed.' }
Assert-Rejected { Assert-NpmPackageName '-opt' } '包名'
Assert-Rejected { Get-NpmPackageUri 'http://remote.example' 'pkg' } '地址无效'
if ((Get-NpmPackageUri 'https://registry.example/' '@test/pkg') -cne 'https://registry.example/@test%2fpkg') { throw 'Wrong package URI.' }

& {
    function Invoke-WebRequest { @{ StatusCode = $code; Content = [Text.Encoding]::UTF8.GetBytes('{"中文":true}') } }
    $code = 200
    if ((Invoke-UpstreamRequest 'unused') -cne '{"中文":true}') { throw 'Binary npm metadata was not decoded as UTF-8.' }
    $code = 503
    Assert-Rejected { Invoke-UpstreamRequest 'unused' } 'HTTP 503'
}

$spec = Get-Harness $repository 'pi'
$source = @{ npm = 'http://127.0.0.1:8192'; offline = $null }
$requests = [Collections.Generic.List[string]]::new()
function Invoke-UpstreamRequest($Uri) {
    $requests.Add($Uri)
    $pkg = $Uri.Substring($source.npm.Length + 1).Replace('%2f','/')
    if ($invalidMetadata) { return $invalidMetadata }
    $versions = @{ '1.6.0' = @{}; '1.8.0-beta' = @{}; '1.9.0' = @{}; '2.0.0' = @{} }
    if ($pkg -ceq $spec.versionPackage) { $versions['1.9.0'].deprecated = 'obsolete' }
    else { $versions['1.7.0'] = @{} }
    @{ name = $pkg; versions = $versions } | ConvertTo-Json -Depth 5
}
$found = Find-HarnessUpstreamCandidate $spec $source '1.5.2' '1.5.2'
if ($found.candidate -ne '1.6.0' -or $found.majorAvailable -ne '2.0.0' -or $found.latest -ne '2.0.0') { throw 'Incorrect version intersection.' }
foreach ($invalidMetadata in '{"name":"bad","versions":{}}','{}oops',('{"name":"' + $spec.versionPackage + '","versions":{"bad":{}}}')) {
    Assert-Rejected { Get-NpmPackageVersions $source.npm $spec.versionPackage } '元数据无效.*--mirror aliyun.*--local-only'
}
$invalidMetadata = $null
$root = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) "shadowbot-upstream-$([guid]::NewGuid())")).FullName
try {
    $state = Join-Path $root '.shadowbot-switch'
    Copy-Item (Join-Path $repository 'harnesses') $root -Recurse
    foreach ($dir in 'scripts','src','launcher','skills','contract') { New-Item -ItemType Directory (Join-Path $root $dir) | Out-Null }
    foreach ($file in 'package.json','package-lock.json','go.mod','go.sum','scripts/toolchain.ps1','install.ps1','contract/schema.sql','tsconfig.json') { Set-Content (Join-Path $root $file) 'fixture' }
    $base = Read-HarnessBaseline $root $spec
    $original = Get-HarnessDependencyHash $base.packageDir
    $offline = @{ npm = $source.npm; offline = $root }
    $requests.Clear()
    $report = Get-HarnessUpdateReport $root $state @($spec) $offline
    if ($report.harnesses[0].status -ne 'skipped' -or $requests.Count) { throw 'Offline report queried upstream.' }
    if ($base.version -ne '1.5.2' -or $base.range -ne '^1.5.2') { throw 'Expected locked baseline.' }
    $lockPath = Join-Path $base.packageDir 'package-lock.json'
    $savedLock = [IO.File]::ReadAllText($lockPath)
    $lock = $savedLock | ConvertFrom-Json -AsHashtable
    $lock.packages["node_modules/$($spec.versionPackage)"].version = '1.5.3'
    Write-AtomicJson $lockPath $lock
    Assert-Rejected { Read-HarnessBaseline $root $spec } '不一致'
    [IO.File]::WriteAllText($lockPath,$savedLock)
    $plan = Resolve-HarnessUpdatePlan $root $state $spec $null $offline -PreferLatest
    if ($plan.source -ne 'pinned' -or $requests.Count) { throw 'Offline use queried upstream.' }
    $plan = Resolve-HarnessUpdatePlan $root $state $spec $null $source -PreferLatest
    if ($plan.version -ne '1.6.0') { throw 'First use missed compatible upstream version.' }
    $invalidMetadata = '{}'
    $plan = Resolve-HarnessUpdatePlan $root $state $spec $null $source -PreferLatest 3>&1
    if ($plan[-1].source -ne 'pinned' -or $plan[0] -isnot [System.Management.Automation.WarningRecord]) { throw 'Missing first-use fallback warning.' }
    $invalidMetadata = $null
    Assert-Rejected { Resolve-HarnessUpdatePlan $root $state $spec $null $offline -Update -HarnessVersion '1.6.0' } '离线模式'
    $toolchain = @{ source = $source }
    function Invoke-ProjectNpm($Toolchain,$Prefix,$Arguments) {
        if ($Arguments[0] -eq 'ci') { return }
        foreach ($flag in '--package-lock-only','--ignore-scripts','--no-audit','--no-fund') {
            if ($flag -notin $Arguments) { throw "Missing $flag" }
        }
        $manifest = Get-Content (Join-Path $Prefix 'package.json') -Raw | ConvertFrom-Json -AsHashtable
        $lock = @{ lockfileVersion = 3; packages = [ordered]@{} }
        foreach ($pkg in $spec.upstream.packages) {
            $manifest.dependencies[$pkg] = '1.6.0'
            $lock.packages["node_modules/$pkg"] = @{ version = '1.6.0'; integrity = 'sha512-YWJj'; resolved = 'https://registry.example/pkg.tgz' }
        }
        $entry = $lock.packages["node_modules/$($spec.versionPackage)"]
        switch ($damage) {
            'version' { $entry.version = '0.1.0' }
            'lockstep' { $manifest.dependencies[$spec.versionPackage] = '0.1.0' }
        }
        $lock.packages[''] = @{ dependencies = $manifest.dependencies }
        Write-AtomicJson (Join-Path $Prefix 'package.json') $manifest
        Write-AtomicJson (Join-Path $Prefix 'package-lock.json') $lock
    }
    foreach ($damage in 'version','lockstep') {
        Assert-Rejected { New-HarnessDependencyLock $root $state $toolchain $spec '1.6.0' } '无效|不一致'
    }
    $damage = $null
    Assert-Rejected { New-HarnessDependencyLock $root $state @{ source = $offline } $spec '1.6.0' } '离线'
    $set = New-HarnessDependencyLock $root $state $toolchain $spec '1.6.0'
    $again = New-HarnessDependencyLock $root $state $toolchain $spec '1.6.0'
    if ($set.packageDir -ne $again.packageDir -or (Get-HarnessDependencyHash $base.packageDir) -ne $original) { throw 'Lock publication modified input or failed to reuse identical content.' }
    $record = @{ version = '1.6.0'; dependencies = $set }
    foreach ($value in $record,($record | ConvertTo-Json -Depth 6 | ConvertFrom-Json)) {
        $plan = Get-HarnessDependencyPlan $root $state $spec $value
        if ($plan.source -ne 'upstream' -or $plan.missing) { throw 'Installed upstream version lost.' }
        if ((Get-HarnessDependencyPlan $root $state $spec $value -Pinned).source -ne 'pinned') { throw 'Pinned override lost.' }
    }
    $record.version = $base.version
    if ((Get-HarnessDependencyPlan $root $state $spec $record).source -ne 'pinned') { throw 'Repository catch-up failed.' }
    $record.version = '1.0.0'
    $record.dependencies.explicit = $true
    if ((Get-HarnessDependencyPlan $root $state $spec $record).source -ne 'upstream') { throw 'Explicit rollback lost.' }
    $record.version = '1.6.0'
    if ((Get-RuntimeReleaseId $root $spec 'node' $base.version) -ne (Get-RuntimeReleaseId $root $spec 'node' $base.version $base)) { throw 'Pinned fingerprint changed.' }
    $id = Get-RuntimeReleaseId $root $spec 'node' $set.version $set
    Add-Content (Join-Path $base.packageDir 'package-lock.json') ' '
    if ($id -ne (Get-RuntimeReleaseId $root $spec 'node' $set.version $set) -or $id -eq (Get-RuntimeReleaseId $root $spec 'node' $set.version @{ source = 'upstream'; lockHash = '0' * 64 })) { throw 'Wrong upstream fingerprint inputs.' }
    function Build-Bridge($Project,$Toolchain,[switch]$SkipTests) {
        New-Item -ItemType Directory -Force (Join-Path $Project 'dist/service') | Out-Null
        Set-Content (Join-Path $Project 'dist/opencode.exe') 'launcher'
    }
    $toolchain.node = Join-Path $root 'node.exe'
    Set-Content $toolchain.node 'node'
    $toolchain.nodeHash = (Get-FileHash $toolchain.node).Hash
    $install = New-RuntimeRelease $root $state $toolchain $spec $null @{} $set
    $release = Get-InstallationRuntime $state $install $spec.id
    $adapterDir = Join-Path $release ('service/' + (Split-Path $spec.adapter))
    if ($install.harnesses[$spec.id].dependencies.lockHash -ne $set.lockHash -or !(Test-HarnessDependencySet $adapterDir $set.lockHash)) { throw 'Runtime used wrong lock set.' }
    Add-Content (Join-Path $set.packageDir 'package-lock.json') 'damaged'
    if (!(Get-HarnessDependencyPlan $root $state $spec $record).missing) { throw 'Damaged lock not detected.' }
    Assert-Rejected { New-RuntimeRelease $root $state $toolchain $spec $null @{} $set } '校验失败'
    Assert-Rejected { Resolve-HarnessUpdatePlan $root $state $spec $record $offline -Update } '缺少已升级'
    'Upstream tests passed.'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
