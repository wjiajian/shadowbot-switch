# A version is bounded before parsing, including its optional build metadata.
$script:SemVerPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z'
function Assert-SemVer([string]$Version) {
    if ($Version.Length -gt 64 -or $Version -cnotmatch $script:SemVerPattern) { throw "版本号无效：$Version（示例 1.6.3）" }
}
function ConvertTo-SemVer([string]$Version) {
    Assert-SemVer $Version
    $parts = [regex]::Match($Version, $script:SemVerPattern).Groups
    @{ core = @(foreach ($i in 1..3) { [bigint]::Parse($parts[$i].Value) }); pre = $parts[4].Value }
}
function Compare-SemVer($A, $B) {
    $left = ConvertTo-SemVer $A
    $right = ConvertTo-SemVer $B
    foreach ($i in 0..2) {
        $cmp = $left.core[$i].CompareTo($right.core[$i])
        if ($cmp) { return $cmp }
    }
    if (!$left.pre -or !$right.pre) { return ([int](!$left.pre) - [int](!$right.pre)) }
    $aParts = $left.pre.Split('.')
    $bParts = $right.pre.Split('.')
    for ($i = 0; $i -lt [Math]::Min($aParts.Count,$bParts.Count); $i++) {
        $x = $aParts[$i]; $y = $bParts[$i]
        if ($x -ceq $y) { continue }
        if ($x -match '^[0-9]+$') {
            if ($y -notmatch '^[0-9]+$') { return -1 }
            return ([bigint]::Parse($x)).CompareTo([bigint]::Parse($y))
        }
        if ($y -match '^[0-9]+$') { return 1 }
        return [string]::CompareOrdinal($x,$y)
    }
    return $aParts.Count.CompareTo($bParts.Count)
}
function Test-SemVerCompatible($Version,$Base) {
    $v = ConvertTo-SemVer $Version
    $b = ConvertTo-SemVer $Base
    $v.core[0] -eq $b.core[0] -and ($b.core[0] -ne 0 -or $v.core[1] -eq $b.core[1])
}
function Test-LoopbackRegistry([uri]$Uri) {
    $Uri.Scheme -eq 'http' -and $Uri.Host -in 'localhost','127.0.0.1'
}
function Get-NpmPackageUri([string]$Registry,$Pkg) {
    Assert-NpmPackageName $Pkg
    $uri = $Registry -as [uri]
    if (!$uri.IsAbsoluteUri -or !$uri.Host -or $uri.UserInfo -or $uri.Fragment -or $uri.Query -or ($uri.Scheme -ne 'https' -and !(Test-LoopbackRegistry $uri))) { throw 'npm 源地址无效。' }
    "$($Registry.TrimEnd('/'))/$($Pkg.Replace('/','%2f'))"
}
function Invoke-UpstreamRequest([string]$Uri) {
    $response = Invoke-WebRequest -Uri $Uri -Headers @{ Accept = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' } -TimeoutSec 20 -MaximumRedirection 3 -SkipHttpErrorCheck
    if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
    if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
    [string]$response.Content
}
function Get-NpmPackageVersions($Registry,$Pkg) {
    try {
        $raw = Invoke-UpstreamRequest (Get-NpmPackageUri $Registry $Pkg)
        try {
            $data = ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 32
        } catch { throw "元数据无效：$($_.Exception.Message)" }
        if ($data.name -cne $Pkg -or $data.versions -isnot [Collections.IDictionary]) { throw '元数据无效' }
        $result = [hashtable]::new([StringComparer]::Ordinal)
        foreach ($v in $data.versions.Keys) {
            if ($v.Length -gt 64 -or $v -cnotmatch $script:SemVerPattern) { continue }
            $entry = $data.versions[$v]
            if ($entry -isnot [Collections.IDictionary] -or ($entry.Contains('version') -and $entry.version -cne $v)) { throw '元数据无效' }
            $result[$v] = @{ deprecated = [bool]$entry.deprecated }
        }
        if (!$result.Count) { throw '元数据无效' }
        $result
    } catch { throw "无法从 $Registry 查询 $Pkg 的版本：$($_.Exception.Message)。可改用 --mirror aliyun，或加 --local-only 只按本地源码重建。" }
}
function Get-LockedHarnessVersion($Dir,$Pkg) {
    $lock = Join-Path $Dir 'package-lock.json'
    if (Test-Path -LiteralPath $lock) {
        $packages = (Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json -AsHashtable).packages
        $version = $packages["node_modules/$Pkg"].version
    } else {
        $range = (Get-Content -Raw -LiteralPath (Join-Path $Dir 'package.json') | ConvertFrom-Json -AsHashtable).dependencies[$Pkg]
        $version = $range.TrimStart('^')
    }
    Assert-SemVer $version
    $version
}

function Read-HarnessBaseline($Project,$Spec) {
    $dir = Join-Path $Project "harnesses/$($Spec.id)"
    $packages = @{}
    if ($Spec.upstream) {
        $deps = (Get-Content -Raw -LiteralPath (Join-Path $dir 'package.json') | ConvertFrom-Json -AsHashtable).dependencies
        if ($deps -isnot [Collections.IDictionary]) { throw 'harness 上游包锁定版本不一致，缺少 dependencies。' }
        $range = $deps[$Spec.versionPackage]
        if ($range -cnotmatch '^\^?\d+\.\d+\.\d+\z') { throw 'harness 版本范围无效。' }
        $floor = $range.TrimStart('^')
        $version = Get-LockedHarnessVersion $dir $Spec.versionPackage
        if (!(Test-SemVerCompatible $version $floor) -or (Compare-SemVer $version $floor) -lt 0 -or (!$range.StartsWith('^') -and $version -cne $floor)) { throw '锁文件版本不满足声明范围。' }
        foreach ($pkg in $Spec.upstream.packages) {
            if ($deps[$pkg] -cne $range -or (Get-LockedHarnessVersion $dir $pkg) -cne $version) { throw 'harness 上游包锁定版本不一致。' }
            $packages[$pkg] = $version
        }
    } else { $version = Get-RuntimeVersion $Project $Spec }
    @{ source = 'pinned'; range = $range; version = $version; packages = $packages; packageDir = $dir; missing = $false; explicit = $false; lockHash = $null }
}
function Get-HarnessDependencyHash($Dir) {
    $lines = foreach ($file in 'package.json','package-lock.json') {
        $path = Join-Path $Dir $file
        "$file $((Get-FileHash -LiteralPath $path).Hash)"
    }
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).ToLowerInvariant()
}
function Get-HarnessDependencyPath($State,$Harness,$LockHash) {
    if ($Harness -cnotmatch '^[a-z][a-z0-9-]{0,63}\z' -or $LockHash -cnotmatch '^[a-f0-9]{64}\z') { throw '依赖锁路径无效。' }
    Join-Path $State "harnesses/$Harness/dependencies/$LockHash"
}
function Test-HarnessDependencySet($Dir,$Hash) {
    try {
        (Get-HarnessDependencyHash $Dir) -ceq $Hash
    } catch { $false }
}
function Get-HarnessDependencyPlan($Project,$State,$Spec,$Record,[switch]$Pinned) {
    $plan = Read-HarnessBaseline $Project $Spec
    $deps = $Record.dependencies
    if ($Pinned -or !$Spec.upstream -or $Record.legacy -or $deps.source -ne 'upstream') { return $plan }
    if (!$deps.explicit -and (Compare-SemVer $Record.version $plan.version) -le 0) { return $plan }
    Get-InstalledDependencySet $State $Spec $Record
}
function Get-InstalledDependencySet($State,$Spec,$Record) {
    $deps = $Record.dependencies
    $dir = Get-HarnessDependencyPath $State $Spec.id $deps.lockHash
    @{ source = 'upstream'; version = $Record.version; packages = $deps.packages; packageDir = $dir
       missing = !(Test-HarnessDependencySet $dir $deps.lockHash); explicit = [bool]$deps.explicit; lockHash = $deps.lockHash }
}
function Find-HarnessUpstreamCandidate($Spec,$Source,$Pinned,$Floor) {
    $maps = @(foreach ($pkg in $Spec.upstream.packages) { Get-NpmPackageVersions $Source.npm $pkg })
    if ((Compare-SemVer $Floor $Pinned) -lt 0) { $Floor = $Pinned }
    $latest = $candidate = $major = $null
    foreach ($v in $maps[0].Keys) {
        if ((ConvertTo-SemVer $v).pre) { continue }
        if (@($maps | Where-Object { !$_.ContainsKey($v) -or $_[$v].deprecated }).Count) { continue }
        if (!$latest -or (Compare-SemVer $v $latest) -gt 0) { $latest = $v }
        if ((Compare-SemVer $v $Floor) -le 0) { continue }
        if ((Test-SemVerCompatible $v $Pinned) -and (!$candidate -or (Compare-SemVer $v $candidate) -gt 0)) { $candidate = $v }
    }
    if ($latest -and (Compare-SemVer $latest $Floor) -gt 0 -and !(Test-SemVerCompatible $latest $Pinned)) { $major = $latest }
    @{ latest = $latest; candidate = $candidate; majorAvailable = $major }
}
function Resolve-HarnessUpdatePlan($Project,$State,$Spec,$Record,$Source,[switch]$Update,[switch]$PreferLatest,[switch]$LocalOnly,[switch]$Pinned,[string]$HarnessVersion) {
    $candidate = $null
    $base = Read-HarnessBaseline $Project $Spec
    $plan = Get-HarnessDependencyPlan $Project $State $Spec $Record -Pinned:($Pinned -or !$Update)
    if (($Update -or $PreferLatest) -and $Spec.upstream -and !$Pinned -and !$LocalOnly) {
        if ($HarnessVersion -and $HarnessVersion -ceq $Record.version -and $HarnessVersion -cne $base.version -and
            !$Record.legacy -and $Record.dependencies.source -eq 'upstream') {
            $plan = Get-InstalledDependencySet $State $Spec $Record
        }
        if ($Source.offline) {
            Write-Host '离线模式：跳过上游版本检查，按本地锁文件构建。'
            if ($HarnessVersion -and $HarnessVersion -cne $base.version -and ($HarnessVersion -cne $plan.version -or $plan.missing)) { throw '离线模式不能解析新版本。' }
        } else {
            Write-Host '  检查上游版本…'
            $checkVersion = if ($HarnessVersion) { $HarnessVersion } elseif ($plan.missing) { $plan.version }
            if ($checkVersion) {
                foreach ($pkg in $Spec.upstream.packages) {
                    $versions = Get-NpmPackageVersions $Source.npm $pkg
                    if (!$versions.ContainsKey($checkVersion)) { throw "$pkg 未发布 $checkVersion。" }
                    if ($versions[$checkVersion].deprecated) { Write-Warning "$pkg $checkVersion 已弃用。" }
                }
            } else {
                try { $candidate = (Find-HarnessUpstreamCandidate $Spec $Source $base.version $plan.version).candidate }
                catch {
                    if ($Update) { throw }
                    Write-Warning "无法查询上游最新版本（$($_.Exception.Message)），改用仓库锁定 $($base.version)。"
                }
                if (!$candidate -and (Compare-SemVer $plan.version $base.version) -lt 0) { $plan = $base }
            }
        }
        $target = if ($HarnessVersion) { $HarnessVersion } else { $candidate }
        if ($target -ceq $base.version) { $plan = $base }
        elseif ($target) {
            if ($target -cne $plan.version) {
                $plan = @{ source = 'upstream'; version = $target; missing = $true }
            }
            $plan.explicit = [bool]$HarnessVersion
            if ($HarnessVersion -and (!(Test-SemVerCompatible $target $base.version) -or (Compare-SemVer $target $base.version) -lt 0)) { Write-Warning "指定版本 $target 超出仓库兼容升级范围。" }
        }
    }
    if ($plan.missing -and ($LocalOnly -or $Source.offline)) { throw '缺少已升级依赖的锁文件，可用 --pinned 恢复仓库锁定版本，或联网后重试。' }
    $plan.needsLock = $plan.missing
    $label = if ($plan.source -eq 'upstream') { '上游；' } else { '' }
    $plan.summary = if ($Update -and !$Spec.upstream) { "$($Spec.name) 未声明上游包，按本地源码重建。" } else { "将使用 $($Spec.name) $($plan.version)（${label}仓库锁定 $($base.version)）。" }
    $plan
}
function New-HarnessDependencyLock($Project,$State,$Toolchain,$Spec,$Version,[switch]$Explicit) {
    if ($Toolchain.source.offline) { throw '离线模式不能解析新版本。' }
    Assert-SemVer $Version
    $base = Read-HarnessBaseline $Project $Spec
    $packages = @{}
    $root = Split-Path (Get-HarnessDependencyPath $State $Spec.id ('0' * 64))
    $work = Join-Path $root "resolve.$PID.$([guid]::NewGuid()).tmp"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    try {
        foreach ($file in 'package.json','package-lock.json') { Copy-Item -LiteralPath (Join-Path $base.packageDir $file) -Destination $work }
        $manifest = Join-Path $work 'package.json'
        $expected = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable).dependencies
        $arguments = @('install','--package-lock-only','--save-exact','--prefer-online','--ignore-scripts','--no-audit','--no-fund')
        foreach ($pkg in $Spec.upstream.packages) {
            $arguments += "$pkg@$Version"
            $expected[$pkg] = $packages[$pkg] = $Version
        }
        Invoke-ProjectNpm $Toolchain $work $arguments
        $actual = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable).dependencies
        $lock = Get-Content -LiteralPath (Join-Path $work 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
        if ($lock.lockfileVersion -ne 3) { throw '需要 npm v3 锁文件。' }
        foreach ($deps in $actual,$lock.packages[''].dependencies) {
            if ($deps.psbase.Count -ne $expected.psbase.Count) { throw '依赖列表不一致。' }
            foreach ($key in $expected.psbase.Keys) { if ($deps[$key] -cne $expected[$key]) { throw '依赖版本不一致。' } }
        }
        foreach ($pkg in $packages.psbase.Keys) {
            $entry = $lock.packages["node_modules/$pkg"]
            if ($entry.version -cne $Version) { throw "$pkg 锁文件条目无效。" }
        }
        $hash = Get-HarnessDependencyHash $work
        $destination = Get-HarnessDependencyPath $State $Spec.id $hash
        $prefix = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($State)) + [IO.Path]::DirectorySeparatorChar
        if (![IO.Path]::GetFullPath($destination).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw '依赖锁路径超出安装目录。' }
        if (!(Test-HarnessDependencySet $destination $hash)) {
            # A damaged content-addressed set can be replaced under the installation lock.
            if (Test-Path -LiteralPath $destination) { Remove-ProjectStage $State $destination }
            [IO.Directory]::Move($work,$destination)
        }
        @{ source = 'upstream'; version = $Version; explicit = [bool]$Explicit; packages = $packages; packageDir = $destination; lockHash = $hash; missing = $false }
    } finally { Remove-ProjectStage $State $work }
}
function Assert-HarnessUpdateOptions($Options,$Target,$Spec,[bool]$Updating) {
    if (!$Updating -and ($Options.Check -or $Options.All -or $Options.LocalOnly -or $Options.Pinned -or $Options.HarnessVersion)) { throw '这些选项只能用于更新。' }
    if (@($Options.LocalOnly,$Options.Pinned,$Options.HarnessVersion | Where-Object { $_ }).Count -gt 1) { throw '--local-only、--version、--pinned 只能选一个。' }
    if ($Options.All -and (!$Options.Check -or $Target)) { throw '--all 只能与 --check 一起使用，且不能指定 harness。' }
    if ($Options.Check -and ($Options.LocalOnly -or $Options.Pinned -or $Options.HarnessVersion -or $Options.Wait -or $Options.ContainsKey('WaitTimeoutSeconds') -or $Options.ShadowBotDirectory)) { throw '--check 只支持 --all、--mirror、--offline-dir 和 --json。' }
    if ($Options.ContainsKey('HarnessVersion')) { Assert-SemVer $Options.HarnessVersion }
    if ($Spec -and !$Spec.upstream -and ($Options.HarnessVersion -or $Options.Pinned)) { throw "$($Spec.name) 未声明上游包，不能指定版本。" }
}
function Get-HarnessUpdateReport($Project,$State,[object[]]$Specs,$Source) {
    $installation = $null
    try { $installation = ConvertTo-HarnessInstallation (Get-Content -LiteralPath (Join-Path $State 'install.json') -Raw -ErrorAction Stop | ConvertFrom-Json -AsHashtable) } catch {}
    $items = @(foreach ($spec in $Specs) {
        $record = if ($installation.harnesses -is [Collections.IDictionary]) { $installation.harnesses[$spec.id] }
            elseif ($installation.harnesses -is [pscustomobject]) { $installation.harnesses.PSObject.Properties[$spec.id].Value }
        $item = @{ id = $spec.id; name = $spec.name; kind = $spec.kind; packages = @(); installed = $record.version; pinned = $null; current = $null
            installedSource = if ($record) { if ($record.dependencies.source -eq 'upstream') { 'upstream' } else { 'pinned' } }
            latest = $null; candidate = $null; majorAvailable = $null }
        try {
            if ($spec.kind -eq 'bundled') {
                $item.status = 'bundled'; $item.message = '随影刀一起更新。'
            } else {
                $base = Read-HarnessBaseline $Project $spec
                $item.pinned = $base.version
                $item.current = (Get-HarnessDependencyPlan $Project $State $spec $record).version
                if (!$spec.upstream) { $item.status = 'not-supported'; $item.message = '未声明上游包。' }
                else {
                    $item.packages = $spec.upstream.packages
                    if ($Source.offline) { $item.status = 'skipped'; $item.message = '离线模式，已跳过。' }
                    else {
                        $found = Find-HarnessUpstreamCandidate $spec $Source $base.version $item.current
                        foreach ($key in $found.Keys) { $item[$key] = $found[$key] }
                        if (!$item.candidate -and (Compare-SemVer $item.current $base.version) -lt 0) { $item.candidate = $base.version }
                        $item.status = if ($item.candidate) { 'update-available' } else { 'up-to-date' }
                        $item.message = if ($item.candidate) { "可更新到 $($item.candidate)。运行 .\switch.ps1 update $($spec.id)" } else { '已是最新。' }
                    }
                }
            }
        } catch { $item.status = 'error'; $item.message = $_.Exception.Message }
        $item
    })
    @{ format = 1; registry = $Source.npm; offline = [bool]$Source.offline; checkedAt = [DateTime]::UtcNow.ToString('o'); harnesses = $items }
}
function Write-HarnessUpdateReport($Report,[switch]$Json) {
    if ($Json) { $Report | ConvertTo-Json -Depth 8; return }
    foreach ($item in $Report.harnesses) {
        $detail = if ($item.pinned) { "$(if ($item.installed) { '已安装 ' + $item.installed } else { '未安装' })（仓库锁定 $($item.pinned)），" }
        "$($item.name)：$detail$($item.message)"
        if ($item.majorAvailable) { "另有新主版本 $($item.majorAvailable)，如需尝试：update $($item.id) --version $($item.majorAvailable)" }
    }
}
