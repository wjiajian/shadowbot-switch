$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot) 'scripts/toolchain.ps1')
$root = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) "shadowbot-toolchain-$([guid]::NewGuid())")).FullName
$saved = @{}
foreach ($key in 'MIRROR', 'OFFLINE_DIR', 'NODE_BASE_URL', 'NPM_REGISTRY', 'GO_BASE_URL', 'GOPROXY') {
    $name = "SHADOWBOT_SWITCH_$key"
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
try {
    $direct = Get-ToolchainSource
    if ($direct.node -ne 'https://nodejs.org/dist' -or $direct.npm -ne 'https://registry.npmjs.org' -or $direct.go -ne 'https://go.dev/dl' -or $direct.goproxy) { throw 'Wrong official sources.' }
    $env:SHADOWBOT_SWITCH_MIRROR = 'aliyun'
    $mirror = Get-ToolchainSource
    if ($mirror.node -ne 'https://mirrors.aliyun.com/nodejs-release' -or $mirror.registry -ne 'https://registry.npmmirror.com' -or $mirror.go -ne 'https://mirrors.aliyun.com/golang' -or $mirror.goproxy -ne 'https://mirrors.aliyun.com/goproxy/,direct') { throw 'Wrong mirror sources.' }
    $env:SHADOWBOT_SWITCH_NODE_BASE_URL = 'https://example.com/'
    if ((Get-ToolchainSource).node -ne 'https://example.com' -or (Get-ToolchainSource direct).node -ne $direct.node) { throw 'Wrong source precedence.' }
    $env:SHADOWBOT_SWITCH_MIRROR = 'invalid'
    try { Get-ToolchainSource; throw 'Invalid mirror accepted.' }
    catch { if ($_.Exception.Message -notmatch '无效的工具链镜像') { throw } }
    $env:SHADOWBOT_SWITCH_MIRROR = 'aliyun'
    $env:SHADOWBOT_SWITCH_NPM_REGISTRY = 'https://custom.example'
    $env:SHADOWBOT_SWITCH_GOPROXY = 'https://custom.example/go'
    foreach ($name in 'direct', 'aliyun') {
        $explicit = Get-ToolchainSource $name
        if ($explicit.npm -like '*custom.example*' -or $explicit.registry -like '*custom.example*' -or $explicit.goproxy -like '*custom.example*') { throw 'Explicit mirror leaked custom sources.' }
    }
    $env:SHADOWBOT_SWITCH_OFFLINE_DIR = $root
    $offline = Get-ToolchainSource
    if (!$offline.offline -or $offline.goproxy -ne 'off') { throw 'Offline option was lost.' }
    $target = Join-Path $root 'verified'
    $file = Join-Path $root 'node.exe'
    Set-Content -LiteralPath $file -Value 'fixture'
    foreach ($algorithm in 'SHA256', 'SHA512') {
        $hash = (Get-FileHash -LiteralPath $file -Algorithm $algorithm).Hash
        Get-ToolchainFile unused $target $hash $algorithm $root @('missing', 'node.exe')
        if ((Get-FileHash -LiteralPath $target -Algorithm $algorithm).Hash -ne $hash) { throw 'Verified file missing.' }
    }
    foreach ($name in 'missing', 'node.exe') {
        try { Get-ToolchainFile unused $target ('0' * 64) SHA256 $root $name; throw 'Accepted invalid input.' }
        catch { if ($_.Exception.Message -notmatch '缺少文件|校验失败') { throw } }
    }
    # Use miniature real archives, substituting their hashes only at the pinned-file boundary.
    & {
        $project = Join-Path $root 'project'
        $bundle = Join-Path $root 'bundle'
        foreach ($path in 'package/bin/npm-cli.js', 'package/lib/cli.js', 'package/node_modules/@npmcli/arborist/package.json',
            'go/bin/go.exe', 'go/pkg/tool/windows_amd64/compile.exe', 'go/src/runtime/runtime2.go') {
            $entry = Join-Path $bundle $path
            New-Item -ItemType Directory -Force -Path (Split-Path $entry) | Out-Null
            Set-Content -LiteralPath $entry -Value 'fixture'
        }
        Set-Content -LiteralPath (Join-Path $bundle 'package/package.json') '{"version":"11.17.0"}'
        Set-Content -LiteralPath (Join-Path $bundle 'go/VERSION') 'go1.25.0'
        $archive = Join-Path $root 'npm-11.17.0.tgz'
        $goArchive = Join-Path $root 'go1.25.0.windows-amd64.zip'
        tar -czf $archive -C $bundle package
        if ($LASTEXITCODE) { throw 'npm fixture archive failed.' }
        Compress-Archive -LiteralPath (Join-Path $bundle 'go') -DestinationPath $goArchive
        if (!$IsWindows) { Set-Alias -Name tar.exe -Value tar }
        $nodeHash = (Get-FileHash $file).Hash
        $fixtureHashes = @{
            npmArchive = (Get-FileHash $archive -Algorithm SHA512).Hash
            goArchive = (Get-FileHash $goArchive).Hash
            npmLayout = Get-ToolchainLayoutHash (Join-Path $bundle 'package')
            goLayout = Get-ToolchainLayoutHash (Join-Path $bundle 'go')
        }
        function Get-ToolchainNodeHash { $nodeHash }
        function Get-ToolchainPackageHashes { $fixtureHashes }
        $chain = Initialize-Toolchain $project direct $root
        foreach ($entry in $chain.node, $chain.npm, $chain.go) {
            if (!(Test-Path -LiteralPath $entry)) { throw "Missing extracted fixture: $entry" }
        }
        Set-Content -LiteralPath (Join-Path $chain.tools 'npm-11.17.0/package.json') 'damaged'
        Set-Content -LiteralPath (Join-Path $chain.tools 'npm-11.17.0/stale.txt') 'old'
        Remove-Item -LiteralPath $file, $archive, $goArchive
        Remove-Item -LiteralPath (Join-Path $chain.tools 'go') -Recurse -Force
        Initialize-Toolchain $project direct $root | Out-Null  # Reuse verified local zip.
        if (Test-Path -LiteralPath (Join-Path $chain.tools 'npm-11.17.0/stale.txt')) { throw 'Stale file survived toolchain re-extract.' }
        Remove-Item -LiteralPath (Join-Path $chain.tools 'npm-11.17.0.tgz'), (Join-Path $chain.tools 'go1.25.0.windows-amd64.zip')
        Initialize-Toolchain $project direct $root | Out-Null  # Only extracted caches remain.
        Remove-Item -LiteralPath $chain.npm
        try { Initialize-Toolchain $project direct $root; throw 'Missing npm accepted.' }
        catch { if ($_.Exception.Message -notmatch '缺少文件.*npm-11.17.0.tgz') { throw } }
    }
    $runner = Join-Path $root 'fixture.ps1'
    Set-Content -LiteralPath $runner -Value @'
$args -join '|' | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'args')
"$env:GOPROXY|$env:GONOPROXY|$env:GOMODCACHE" | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'proxy')
$global:LASTEXITCODE = 0
'@
    $chain = @{ node = $runner; go = $runner; npm = 'npm'; tools = $root; source = $mirror }
    $previous = $env:GOPROXY
    Build-Bridge $root $chain -SkipTests
    if ($env:GOPROXY -cne $previous -or (Get-Content -LiteralPath (Join-Path $root 'proxy') -Raw) -notmatch [regex]::Escape($mirror.goproxy)) { throw 'Go proxy was not scoped to the build.' }
    $chain.source = $offline
    $externalNpm = Join-Path $root 'npm-cache'
    $externalGo = Join-Path $root 'go-mod'
    New-Item -ItemType Directory -Path $externalGo, $externalNpm | Out-Null
    $chain.tools = Join-Path $root 'project/.tools'
    Remove-Item -LiteralPath (Join-Path $root 'args'), (Join-Path $root 'proxy') -ErrorAction SilentlyContinue
    Build-Bridge $root $chain -SkipTests
    if ("off|none|$externalGo" -notin (Get-Content -LiteralPath (Join-Path $root 'proxy'))) { throw 'Offline Go settings lost.' }
    $logged = Get-Content -LiteralPath (Join-Path $root 'args') -Raw
    if (!$logged.Contains("--cache|$externalNpm|") -or $logged -notmatch '--registry=https://registry.npmmirror.com' -or $logged -notmatch '--offline') { throw 'npm options were lost.' }
    'Toolchain tests passed.'
} finally {
    foreach ($name in $saved.Keys) {
        if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
    Remove-Item -LiteralPath $root -Recurse -Force
}
