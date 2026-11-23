function Get-ToolchainSource([string]$Mirror, [string]$OfflineToolchainDir) {
    $explicitMirror = [bool]$Mirror
    if (!$Mirror) { $Mirror = $env:SHADOWBOT_SWITCH_MIRROR }
    if (!$Mirror) { $Mirror = 'direct' }
    if ($Mirror -notin 'direct', 'aliyun') { throw "无效的工具链镜像：$Mirror" }
    if (!$OfflineToolchainDir) { $OfflineToolchainDir = $env:SHADOWBOT_SWITCH_OFFLINE_DIR }
    if ($OfflineToolchainDir) {
        if (!(Test-Path -LiteralPath $OfflineToolchainDir -PathType Container)) { throw "离线目录不存在：$OfflineToolchainDir" }
        $OfflineToolchainDir = (Resolve-Path -LiteralPath $OfflineToolchainDir).Path
    }
    $source = @{ node = 'https://nodejs.org/dist'; npm = 'https://registry.npmjs.org'; go = 'https://go.dev/dl'
        registry = $null; goproxy = $null; offline = $OfflineToolchainDir }
    if ($Mirror -eq 'aliyun') {
        $source.node = 'https://mirrors.aliyun.com/nodejs-release'
        $source.registry = $source.npm = 'https://registry.npmmirror.com'
        $source.go = 'https://mirrors.aliyun.com/golang'
        $source.goproxy = 'https://mirrors.aliyun.com/goproxy/,direct'
    }
    if (!$explicitMirror) {
        if ($env:SHADOWBOT_SWITCH_NODE_BASE_URL) { $source.node = $env:SHADOWBOT_SWITCH_NODE_BASE_URL.TrimEnd('/') }
        if ($env:SHADOWBOT_SWITCH_NPM_REGISTRY) { $source.registry = $source.npm = $env:SHADOWBOT_SWITCH_NPM_REGISTRY.TrimEnd('/') }
        if ($env:SHADOWBOT_SWITCH_GO_BASE_URL) { $source.go = $env:SHADOWBOT_SWITCH_GO_BASE_URL.TrimEnd('/') }
        if ($env:SHADOWBOT_SWITCH_GOPROXY) { $source.goproxy = $env:SHADOWBOT_SWITCH_GOPROXY }
    }
    if ($source.offline) { $source.goproxy = 'off' }
    $source
}

function Get-ToolchainFile($Uri, $Path, $Hash, $Algorithm = 'SHA256', $OfflineDir, [string[]]$Names) {
    if ((Test-Path -LiteralPath $Path) -and (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash -eq $Hash) { return }
    $temporary = "$Path.$PID.tmp"
    try {
        if ($OfflineDir) {
            $file = foreach ($name in $Names) {
                $candidate = Join-Path $OfflineDir $name
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate; break }
            }
            if (!$file) { throw "离线目录缺少文件：$OfflineDir ($($Names -join ' 或 '))" }
            Copy-Item -LiteralPath $file -Destination $temporary
        } else {
            curl.exe -fLsS --retry 2 --output $temporary -- $Uri
            if ($LASTEXITCODE -ne 0) { throw "下载失败：$Uri" }
        }
        if ((Get-FileHash -LiteralPath $temporary -Algorithm $Algorithm).Hash -ne $Hash) {
            throw "工具链文件校验失败：$Path。"
        }
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-ToolchainNodeHash {
    '86FC4785327DB5F5C7558DC6156C543B433C313E813A222E088086222AB4AFA6'
}

# Layout hashes cover every relative filename and length in the pinned, verified archives.
# They detect incomplete extractions without reading the entire Go SDK on every offline build.
function Get-ToolchainLayoutHash($Directory) {
    if (!(Test-Path -LiteralPath $Directory -PathType Container)) { return '' }
    $options = [IO.EnumerationOptions]::new()
    $options.RecurseSubdirectories = $true
    $options.AttributesToSkip = [IO.FileAttributes]::ReparsePoint
    $options.IgnoreInaccessible = $false
    $entries = [Collections.Generic.List[string]]::new()
    foreach ($file in ([IO.DirectoryInfo]$Directory).EnumerateFiles('*', $options)) {
        $relative = [IO.Path]::GetRelativePath($Directory, $file.FullName).Replace('\', '/')
        $entries.Add("$relative`t$($file.Length)")
    }
    $entries.Sort([StringComparer]::Ordinal)
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $entries))
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}

function Get-ToolchainPackageHashes {
    @{
        npmArchive = [Convert]::ToHexString([Convert]::FromBase64String('PurxiZexEHDTE4SSaLI3ZrnbAGiZfeyUcQcxcP5D+hfytNAze/D1IzDuInTn9XVLIbAQUnQuSPXJx02LHjLvQw=='))
        npmLayout = 'CDDC1A924F4A3C5FC3B2169876D31F3C77CB2A5274840464E40782A485F3CDE6'
        goArchive = '89efb4f9b30812eee083cc1770fdd2913c14d301064f6454851428f9707d190b'
        goLayout = 'D2993276482880BF72060B8121F47CF9890E864550C188C413150522BF4C1FF2'
    }
}

function Reset-ToolchainDirectory($Directory) {
    if (!(Test-Path -LiteralPath $Directory)) { return }
    if ((Get-Item -LiteralPath $Directory -Force).LinkType) { throw "不能清理链接目录：$Directory" }
    Remove-Item -LiteralPath $Directory -Recurse -Force
}

function Initialize-Toolchain($Project, $Mirror, $OfflineToolchainDir) {
    $source = Get-ToolchainSource $Mirror $OfflineToolchainDir
    $tools = Join-Path $Project '.tools'
    $nodeDirectory = Join-Path $tools 'node'
    New-Item -ItemType Directory -Force -Path $nodeDirectory | Out-Null
    $node = Join-Path $nodeDirectory 'node.exe'
    $nodeHash = Get-ToolchainNodeHash
    Get-ToolchainFile "$($source.node)/v24.22.3/win-x64/node.exe" $node $nodeHash SHA256 $source.offline @('node.exe', 'v24.22.3/win-x64/node.exe')

    $npm = Join-Path $tools 'npm-11.17.0/bin/npm-cli.js'
    $npmRoot = Split-Path (Split-Path $npm)
    $hashes = Get-ToolchainPackageHashes
    if (!(Test-Path -LiteralPath $npm -PathType Leaf) -or
        ($source.offline -and (Get-ToolchainLayoutHash $npmRoot) -ne $hashes.npmLayout)) {
        $archive = Join-Path $tools 'npm-11.17.0.tgz'
        Get-ToolchainFile "$($source.npm)/npm/-/npm-11.17.0.tgz" $archive $hashes.npmArchive SHA512 $source.offline 'npm-11.17.0.tgz'
        Reset-ToolchainDirectory $npmRoot
        New-Item -ItemType Directory -Force -Path $npmRoot | Out-Null
        tar.exe -xf $archive -C $npmRoot --strip-components 1
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $npm)) { throw 'npm 解压失败，请重试。' }
    }

    $go = Join-Path $tools 'go/bin/go.exe'
    $goRoot = Join-Path $tools 'go'
    if (!(Test-Path -LiteralPath $go -PathType Leaf) -or
        ($source.offline -and (Get-ToolchainLayoutHash $goRoot) -ne $hashes.goLayout)) {
        $archive = Join-Path $tools 'go1.25.0.windows-amd64.zip'
        Get-ToolchainFile "$($source.go)/go1.25.0.windows-amd64.zip" $archive $hashes.goArchive SHA256 $source.offline 'go1.25.0.windows-amd64.zip'
        Reset-ToolchainDirectory $goRoot
        tar.exe -xf $archive -C $tools
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $go)) { throw 'Go 解压失败，请重试。' }
    }
    @{ tools = $tools; node = $node; nodeHash = $nodeHash; npm = $npm; go = $go; source = $source }
}

function Invoke-ProjectNpm($Toolchain, $Prefix, [string[]]$Arguments) {
    $tools = $Toolchain.tools
    if ($Toolchain.source.registry) { $Arguments += "--registry=$($Toolchain.source.registry)" }
    if ($Toolchain.source.offline) { $Arguments += '--offline' }
    # Keep successful installs quiet: warnings are hidden and the stdout summary
    # ("added N packages") is shown only when npm fails. Errors still reach stderr.
    $cache = Join-Path $tools 'npm-cache'
    if ($Toolchain.source.offline) {
        $external = Join-Path $Toolchain.source.offline 'npm-cache'
        if (Test-Path -LiteralPath $external -PathType Container) { $cache = $external }
    }
    $output = & $Toolchain.node $Toolchain.npm --prefix $Prefix --cache $cache `
        --userconfig (Join-Path $tools 'npm-userrc') --globalconfig (Join-Path $tools 'npm-globalrc') `
        --global=false --no-update-notifier --loglevel=error @Arguments
    if ($LASTEXITCODE -ne 0) {
        $output | Out-Host
        if ($Toolchain.source.offline) { throw "离线 npm 安装失败，请确认 $cache 包含锁文件所需依赖。" }
        throw "npm $($Arguments[0]) 失败，原因见上方输出。"
    }
}

function Build-Bridge($Project, $Toolchain, [switch]$SkipTests) {
    Push-Location -LiteralPath $Project
    $savedEnvironment = @{}
    $settings = @{
        Path = "$(Split-Path $Toolchain.node);$env:Path"
        GOENV = 'off'
        GOPATH = Join-Path $Toolchain.tools 'go-work'
        GOCACHE = Join-Path $Toolchain.tools 'go-cache'
        GOTOOLCHAIN = 'local'
        GOOS = 'windows'
        GOARCH = 'amd64'
        CGO_ENABLED = '0'
    }
    if ($Toolchain.source.goproxy) { $settings.GOPROXY = $Toolchain.source.goproxy }
    if ($Toolchain.source.offline) {
        $settings.GONOPROXY = 'none'
        foreach ($name in 'go-mod', 'pkg/mod') {
            $cache = Join-Path $Toolchain.source.offline $name
            if (Test-Path -LiteralPath $cache -PathType Container) { $settings.GOMODCACHE = $cache; break }
        }
    }
    try {
        foreach ($name in $settings.Keys) {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
        }
        Invoke-ProjectNpm $Toolchain $Project @('ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        $serviceOutput = [IO.Path]::GetFullPath((Join-Path $Project 'dist/service'))
        if ((Split-Path (Split-Path $serviceOutput)) -ne [IO.Path]::GetFullPath($Project).TrimEnd('\')) { throw 'Unexpected build output directory.' }
        if (Test-Path -LiteralPath $serviceOutput) { Remove-Item -LiteralPath $serviceOutput -Recurse -Force }
        & $Toolchain.node (Join-Path $Project 'node_modules/typescript/bin/tsc') --project tsconfig.json
        if ($LASTEXITCODE -ne 0) { throw 'TypeScript 编译失败，原因见上方输出。' }
        & $Toolchain.go build -trimpath -o dist/opencode.exe ./launcher
        if ($LASTEXITCODE -ne 0) { throw '启动器编译失败，原因见上方输出。' }
        if (!$SkipTests) {
            & $Toolchain.node --test 'test/*.test.mjs'
            if ($LASTEXITCODE -ne 0) { throw 'Node tests failed.' }
            & $Toolchain.go test ./launcher
            if ($LASTEXITCODE -ne 0) { throw 'Launcher tests failed.' }
            & ./test/activation.test.ps1
            & ./test/experience.test.ps1
            & ./test/harnesses.test.ps1
            & ./test/toolchain.test.ps1
            & ./test/uninstall.test.ps1
            & ./test/ui.test.ps1
        }
    } finally {
        foreach ($name in $savedEnvironment.Keys) {
            if ($null -eq $savedEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
        }
        Pop-Location
    }
}
