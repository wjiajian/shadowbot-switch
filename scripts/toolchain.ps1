function Get-ToolchainFile($Uri, $Path, $Hash, $Algorithm = 'SHA256') {
    if ((Test-Path -LiteralPath $Path) -and (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash -eq $Hash) { return }
    $temporary = "$Path.$PID.tmp"
    try {
        curl.exe -fLsS --retry 2 --output $temporary $Uri
        if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $temporary -Algorithm $Algorithm).Hash -ne $Hash) {
            throw "下载的文件校验失败：$Path。检查网络后重试。"
        }
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Initialize-Toolchain($Project) {
    $tools = Join-Path $Project '.tools'
    $nodeDirectory = Join-Path $tools 'node'
    New-Item -ItemType Directory -Force -Path $nodeDirectory | Out-Null
    $node = Join-Path $nodeDirectory 'node.exe'
    $nodeHash = '86FC4785327DB5F5C7558DC6156C543B433C313E813A222E088086222AB4AFA6'
    Get-ToolchainFile 'https://nodejs.org/dist/v24.22.3/win-x64/node.exe' $node $nodeHash

    $npm = Join-Path $tools 'npm-11.17.0/bin/npm-cli.js'
    if (!(Test-Path -LiteralPath $npm)) {
        $archive = Join-Path $tools 'npm-11.17.0.tgz'
        $directory = Split-Path (Split-Path $npm)
        $integrity = 'PurxiZexEHDTE4SSaLI3ZrnbAGiZfeyUcQcxcP5D+hfytNAze/D1IzDuInTn9XVLIbAQUnQuSPXJx02LHjLvQw=='
        $npmHash = [Convert]::ToHexString([Convert]::FromBase64String($integrity))
        Get-ToolchainFile 'https://registry.npmjs.org/npm/-/npm-11.17.0.tgz' $archive $npmHash 'SHA512'
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
        tar.exe -xf $archive -C $directory --strip-components 1
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $npm)) { throw 'npm 解压失败，请重试。' }
    }

    $go = Join-Path $tools 'go/bin/go.exe'
    if (!(Test-Path -LiteralPath $go)) {
        $archive = Join-Path $tools 'go1.25.0.windows-amd64.zip'
        Get-ToolchainFile 'https://go.dev/dl/go1.25.0.windows-amd64.zip' $archive '89efb4f9b30812eee083cc1770fdd2913c14d301064f6454851428f9707d190b'
        tar.exe -xf $archive -C $tools
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $go)) { throw 'Go 解压失败，请重试。' }
    }
    @{ tools = $tools; node = $node; nodeHash = $nodeHash; npm = $npm; go = $go }
}

function Invoke-ProjectNpm($Toolchain, $Prefix, [string[]]$Arguments) {
    $tools = $Toolchain.tools
    # Keep successful installs quiet: warnings are hidden and the stdout summary
    # ("added N packages") is shown only when npm fails. Errors still reach stderr.
    $output = & $Toolchain.node $Toolchain.npm --prefix $Prefix --cache (Join-Path $tools 'npm-cache') `
        --userconfig (Join-Path $tools 'npm-userrc') --globalconfig (Join-Path $tools 'npm-globalrc') `
        --global=false --no-update-notifier --loglevel=error @Arguments
    if ($LASTEXITCODE -ne 0) {
        $output | Out-Host
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
        }
    } finally {
        foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
        Pop-Location
    }
}
