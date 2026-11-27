# Local web UI for ShadowBot Switch. ui.ps1 starts the server; tests dot-source this file.
# The page only reaches whitelisted management commands, always with explicit arguments.
. (Join-Path $PSScriptRoot 'harnesses.ps1')
. (Join-Path $PSScriptRoot 'discovery.ps1')
. (Join-Path $PSScriptRoot 'processes.ps1')
. (Join-Path $PSScriptRoot 'runtime.ps1')
. (Join-Path $PSScriptRoot 'toolchain.ps1')

$script:UiSkillPattern = '^[a-z0-9]+(?:-[a-z0-9]+)*$'   # same rule as management.ts
$script:UiMcpPattern = '^[A-Za-z0-9_-]{1,64}$'          # same rule as mcp-config.ts
$script:UiIdleSeconds = 45
$script:UiWaitSeconds = 300
$script:UiFiles = @{
    '/' = @('index.html', 'text/html; charset=utf-8')
    '/index.html' = @('index.html', 'text/html; charset=utf-8')
    '/app.css' = @('app.css', 'text/css; charset=utf-8')
    '/app.js' = @('app.js', 'text/javascript; charset=utf-8')
}
$script:UiPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
$script:Ui = $null

function New-UiToken {
    $bytes = [byte[]]::new(32)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Test-UiToken([string]$Expected, [string]$Actual) {
    if (!$Expected -or !$Actual -or $Expected.Length -ne $Actual.Length) { return $false }
    $difference = 0
    for ($i = 0; $i -lt $Expected.Length; $i++) { $difference = $difference -bor ([int]$Expected[$i] -bxor [int]$Actual[$i]) }
    $difference -eq 0
}

function Assert-UiName($Value, [string]$Pattern, [string]$Label) {
    $text = [string]$Value
    if ($text -cnotmatch $Pattern) { throw "$Label 名称无效。" }
    $text
}

function Assert-UiPath($Value) {
    $text = ([string]$Value).Trim().Trim('"')
    if (!$text -or $text.Length -gt 1024 -or $text -match '[\x00-\x1f"]' -or ![IO.Path]::IsPathFullyQualified($text)) {
        throw '请填写完整路径，例如 D:\Skills\report-export。'
    }
    $text
}

function Assert-UiHarness($Value) {
    $id = [string]$Value
    if (@(Get-HarnessRegistry $script:Ui.Project).id -cnotcontains $id) { throw "未知 harness：$id" }
    $id
}

function Get-UiScopeArguments($Request) {
    if ($Request.app) { return @('--app', (Assert-UiPath $Request.app)) }
    @('--global')
}

function Assert-UiDigest($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '\A(?:[0-9a-f]{64}|absent)\z') { throw '文件摘要无效。' }
    $Value
}

function Assert-UiBackupId($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z') { throw '备份编号无效。' }
    $Value
}

function Assert-UiCount($Value, $Min, $Max) {
    if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt $Min -or $Value -gt $Max) { throw '分页参数无效。' }
    [string]$Value
}

function Assert-UiRuleScope($Value) {
    if ($Value -isnot [string] -or $Value -cnotin 'installation', 'application') { throw '规则范围无效。' }
    $Value
}

function Assert-UiIdle {
    if ($script:Ui.Job -and !$script:Ui.Job.Done) { throw '任务运行中，结束后再保存。' }
}

function Get-UiStageDirectory {
    $folder = Join-Path $script:Ui.State 'ui-staging'
    foreach ($path in $script:Ui.State, $folder) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($item -and (!$item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '暂存目录不能是链接或普通文件。' }
    }
    [void][IO.Directory]::CreateDirectory($folder)
    $folder
}

function New-UiStageFile([string]$Text) {
    try { $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Text) }
    catch { throw '内容包含无法编码的字符。' }
    $id = [Guid]::NewGuid().ToString('N')
    $path = Join-Path (Get-UiStageDirectory) "$id.json"
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    if ($null -ne $script:Ui.StageFiles) { [void]$script:Ui.StageFiles.Add($path) }
    @{ id = $id; path = $path; bytes = $bytes.Length }
}

function Get-UiStagePath($Id) {
    if ($Id -isnot [string] -or $Id -cnotmatch '\A[0-9a-f]{32}\z') { throw '暂存编号无效。' }
    $path = Join-Path (Get-UiStageDirectory) "$Id.json"
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (!$item -or $item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '暂存文件已过期，请重新选择文件。' }
    $path
}

function Remove-UiStageFile([string]$Path) {
    [IO.File]::Delete($Path)
    if ($null -ne $script:Ui.StageFiles) { [void]$script:Ui.StageFiles.Remove($Path) }
}

function Clear-UiStage([TimeSpan]$OlderThan, [switch]$OwnedOnly) {
    if (!(Test-Path -LiteralPath (Join-Path $script:Ui.State 'ui-staging'))) { return }
    $folder = Get-UiStageDirectory
    foreach ($item in Get-ChildItem -LiteralPath $folder -Force -File) {
        if ($OwnedOnly -and !$script:Ui.StageFiles.Contains($item.FullName)) { continue }
        if ($item.Name -cmatch '\A[0-9a-f]{32}\.json\z' -and $item.LastWriteTimeUtc -le [DateTime]::UtcNow.Subtract($OlderThan)) {
            Remove-UiStageFile $item.FullName
        }
    }
}

# Maps a page request onto control arguments. Anything not listed here is refused.
function ConvertTo-UiCommand($Request) {
    $command = [string]$Request.cmd
    if ($command -cin 'reload','skills.add','skills.enable','skills.disable','skills.remove','mcp.add','mcp.enable','mcp.disable','mcp.remove','config.open','apps.add','apps.remove','rules.remove') { Assert-UiIdle }
    switch -CaseSensitive ($command) {
        'rules.show' { return @('rules', 'show', '--json') + (Get-UiScopeArguments $Request) }
        'rules.remove' { return @('rules', 'remove', '--scope', (Assert-UiRuleScope $Request.scope), '--expect', (Assert-UiDigest $Request.expect), '--json') + (Get-UiScopeArguments $Request) }
        'settings.show' { return @('settings', 'show', '--json') + (Get-UiScopeArguments $Request) }
        'status' { return @('status', '--json') }
        'log' { return @('log', '--limit', (Assert-UiCount ($Request.limit ?? 50) 1 500), '--offset', (Assert-UiCount ($Request.offset ?? 0) 0 ([int]::MaxValue)), '--json') }
        'config.backups' { return @('config', 'backups', '--limit', (Assert-UiCount ($Request.limit ?? 20) 1 100), '--offset', (Assert-UiCount ($Request.offset ?? 0) 0 ([int]::MaxValue)), '--json', '--global') }
        'config.restore' {
            if ($Request.dryRun -isnot [bool]) { throw 'dryRun 需要布尔值。' }
            $arguments = @('config', 'restore', (Assert-UiBackupId $Request.id))
            if ($Request.dryRun) { $arguments += '--dry-run' } else { Assert-UiIdle }
            return $arguments + @('--json', '--global')
        }
        { $_ -cin 'apps.add', 'apps.remove' } { return @('apps', $command.Split('.')[1], (Assert-UiPath $Request.path), '--json') }
        'apps' { return @('apps', 'list', '--json') }
        'reload' { return @('reload', '--json') }
        'doctor' { return @('doctor', '--json') + (Get-UiScopeArguments $Request) }
        'skills.list' { return @('skills', 'list', '--json') + (Get-UiScopeArguments $Request) }
        'skills.add' { return @('skills', 'add', (Assert-UiPath $Request.path), '--json') + (Get-UiScopeArguments $Request) }
        { $_ -cin 'skills.enable', 'skills.disable', 'skills.remove' } {
            return @('skills', $command.Split('.')[1], (Assert-UiName $Request.name $script:UiSkillPattern 'Skill'), '--json') + (Get-UiScopeArguments $Request)
        }
        'mcp.list' { return @('mcp', 'list', '--json') + (Get-UiScopeArguments $Request) }
        'mcp.status' { return @('mcp', 'status', '--json') + (Get-UiScopeArguments $Request) }
        'mcp.test' {
            $arguments = @('mcp', 'test')
            if ($Request.name) { $arguments += Assert-UiName $Request.name $script:UiMcpPattern 'MCP' }
            return $arguments + @('--json') + (Get-UiScopeArguments $Request)
        }
        { $_ -cin 'mcp.enable', 'mcp.disable', 'mcp.remove' } {
            return @('mcp', $command.Split('.')[1], (Assert-UiName $Request.name $script:UiMcpPattern 'MCP'), '--json') + (Get-UiScopeArguments $Request)
        }
        'mcp.add' {
            $arguments = @('mcp', 'add', (Assert-UiName $Request.name $script:UiMcpPattern 'MCP'))
            if ($Request.transport -ceq 'http') {
                $url = ([string]$Request.url).Trim()
                if ($url -notmatch '^https?://\S+$') { throw '请填写以 http:// 或 https:// 开头的地址。' }
                $arguments += @('--url', $url)
            } elseif ($Request.transport -ceq 'stdio') {
                $executable = ([string]$Request.command).Trim()
                if (!$executable) { throw '请填写命令。' }
                $arguments += @('--command', $executable)
                foreach ($item in @($Request.args)) {
                    $text = [string]$item
                    if ($text.Trim()) { $arguments += @('--arg', $text) }
                }
                $directory = ([string]$Request.cwd).Trim()
                if ($directory) { $arguments += @('--cwd', $directory) }
            } else { throw '类型只能是 stdio 或 http。' }
            if ($Request.permission) {
                if ($Request.permission -cnotin 'ask', 'allow', 'deny') { throw '工具授权只能是询问、允许或拒绝。' }
                $arguments += @('--permission', [string]$Request.permission)
            }
            return $arguments + @('--json') + (Get-UiScopeArguments $Request)
        }
        'config.open' {
            if ($Request.target -cnotin 'mcp', 'skills') { throw '只能打开 mcp 或 skills 配置。' }
            return @('config', 'open', [string]$Request.target, '--json') + (Get-UiScopeArguments $Request)
        }
    }
    throw "不支持的操作：$command"
}

function Assert-UiMirror($Value) {
    if ($Value -isnot [string] -or $Value -cnotin 'direct', 'aliyun') { throw '下载源无效。' }
    $Value
}

function ConvertTo-UiJobArguments($Request) {
    $command = [string]$Request.cmd
    # @() keeps a one-item result as an array, so += appends instead of joining strings.
    $arguments = @(switch -CaseSensitive ($command) {
        'use' { 'use'; Assert-UiHarness $Request.harness }
        'update' { 'update'; Assert-UiHarness $Request.harness }
        'repair' { 'repair' }
        'uninstall' {
            'uninstall'; '--yes'
            if ($null -ne $Request.purgeData -and $Request.purgeData -isnot [bool]) { throw 'purgeData 需要布尔值。' }
            if ($Request.purgeData) { '--purge-data' }
        }
        default { throw "不支持的任务：$command" }
    })
    if ($Request.ContainsKey('localOnly')) {
        if ($command -cne 'update') { throw 'localOnly 只能用于更新。' }
        if ($Request.localOnly -isnot [bool]) { throw 'localOnly 需要布尔值。' }
        if ($Request.localOnly) { $arguments += '--local-only' }
    }
    if ($command -in 'use', 'update', 'repair' -and $Request.ContainsKey('mirror')) { $arguments += @('--mirror', (Assert-UiMirror $Request.mirror)) }
    if ($command -in 'use', 'update', 'repair' -and $Request.ContainsKey('offlineDir')) {
        $arguments += @('--offline-dir', (Assert-UiPath $Request.offlineDir))
    }
    $arguments += @('--wait', '--timeout', [string]$script:UiWaitSeconds)
    if ($command -cne 'repair' -and $Request.shadowbotDir) { $arguments += @('--shadowbot-dir', (Assert-UiPath $Request.shadowbotDir)) }
    $arguments
}

function ConvertTo-UiQuoted([string]$Value) {
    # PowerShell also treats the typographic single quotes as quote characters.
    "'" + ($Value -replace "['\u2018\u2019\u201A\u201B]", '$0$0') + "'"
}

# A script for -EncodedCommand that runs one file with literal arguments and UTF-8 output.
function New-UiEncodedCommand([string]$Script, [string[]]$Arguments) {
    $call = (@(ConvertTo-UiQuoted $Script) + @($Arguments | ForEach-Object { ConvertTo-UiQuoted $_ })) -join ' '
    $text = "try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new(`$false) } catch { }`n& $call`nexit `$LASTEXITCODE"
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text))
}

function ConvertTo-UiPlainText([string]$Line) {
    $Line -replace '\x1b\[[0-9;?]*[ -/]*[@-~]', ''
}

function New-UiProcessInfo([string]$FileName, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($FileName)
    foreach ($item in $Arguments) { $info.ArgumentList.Add($item) }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $info.WorkingDirectory = $script:Ui.Project
    $info
}

function Invoke-UiProcess([string]$FileName, [string[]]$Arguments, [int]$TimeoutSeconds = 120) {
    $process = [Diagnostics.Process]::Start((New-UiProcessInfo $FileName $Arguments))
    try {
        $process.StandardInput.Close()
        $output = [IO.MemoryStream]::new()
        $errors = [IO.MemoryStream]::new()
        $copies = [Threading.Tasks.Task[]]@(
            $process.StandardOutput.BaseStream.CopyToAsync($output),
            $process.StandardError.BaseStream.CopyToAsync($errors))
        if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill($true) } catch { }
            throw "命令超过 $TimeoutSeconds 秒没有结束，已停止。"
        }
        # A program the command started (config open starts Notepad) may keep the pipes open,
        # so take what was written once the command exits instead of waiting for end of stream.
        try { [void][Threading.Tasks.Task]::WaitAll($copies, 2000) } catch { }
        $utf8 = [Text.UTF8Encoding]::new($false)
        [ordered]@{ exitCode = $process.ExitCode; stdout = $utf8.GetString($output.ToArray()); stderr = (ConvertTo-UiPlainText $utf8.GetString($errors.ToArray())) }
    } finally { $process.Dispose() }
}

function Invoke-UiControl([string[]]$Arguments) {
    $control = Join-Path $script:Ui.State 'shadowbot-pi.exe'
    if (!(Test-Path -LiteralPath $control -PathType Leaf)) { throw '安装尚未就绪。先在 Harness 页面安装并切换。' }
    # The installed launcher's management whitelist already accepts config.
    if ($Arguments[0] -cin 'rules','settings','log') { $Arguments = @('config') + $Arguments }
    Invoke-UiProcess $control $Arguments 120
}

function Get-UiShadowBotVersion([string]$Directory) {
    if (!$Directory) { return $null }
    $executable = Join-Path $Directory 'ShadowBot.exe'
    if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { return $null }
    try { (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion } catch { $null }
}

# The page may pass shadowbotDir before installing, after the user corrects the directory.
function Get-UiState($Request) {
    $project = $script:Ui.Project
    $state = $script:Ui.State
    $manifest = Join-Path $state 'install.json'
    $registry = @(Get-HarnessRegistry $project)
    $bundled = @($registry | Where-Object kind -eq 'bundled')[0]
    $installation = $null
    $selected = $bundled.id
    $installed = $false
    $problem = $null
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        try {
            $installation = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
            $mode = (Get-Content -LiteralPath (Join-Path $state 'backend.json') -Raw | ConvertFrom-Json).mode
            if ($mode -and $mode -ne 'observe') { $selected = [string]$mode }
            $installed = $true
        } catch { $problem = '安装记录无法读取。保留 .shadowbot-switch 数据，恢复安装记录后运行修复。' }
    }
    $harnesses = @(foreach ($spec in $registry) {
        $record = if ($installation -and $installation.harnesses) { $installation.harnesses.PSObject.Properties[$spec.id].Value } else { $null }
        $version = if ($record -and $record.version) { [string]$record.version }
            elseif ($spec.id -eq 'pi' -and $installation -and $installation.piVersion) { [string]$installation.piVersion }
            elseif ($spec.kind -eq 'bundled') { $installation.bundled.version ?? $spec.version }
            else { $null }
        $pinnedVersion = $availableVersion = $null
        $updateStatus = if ($spec.kind -eq 'bundled') { 'bundled' } elseif (!$version) { 'not-installed' } else { 'unknown' }
        if ($spec.kind -eq 'managed') {
            try {
                $pinnedVersion = Get-RuntimeVersion $project $spec
                $plan = Get-HarnessDependencyPlan $project $state $spec $record
                $availableVersion = $plan.version
                if (!$plan.missing -and $version -and $record.release -and !$record.legacy) {
                    $localRelease = Get-RuntimeReleaseId $project $spec (Get-ToolchainNodeHash) $availableVersion $plan
                    $updateStatus = if ($localRelease -eq $record.release) { 'current' } else { 'different' }
                }
            } catch { $updateStatus = 'unknown' }
        }
        [ordered]@{
            id = $spec.id; name = $spec.name; kind = $spec.kind
            installed = $spec.kind -eq 'bundled' -or [bool]$version
            selected = $spec.id -eq $selected
            version = $version
            pinnedVersion = $pinnedVersion
            dependencySource = if ($version -and $spec.kind -eq 'managed') { if ($record.dependencies.source -eq 'upstream') { 'upstream' } else { 'pinned' } }
            upstreamCapable = [bool]$spec.upstream
            upstream = if ($script:Ui.Upstream) { $script:Ui.Upstream.items[$spec.id] }
            availableVersion = $availableVersion; updateStatus = $updateStatus
            skills = [bool]$spec.capabilities.skills; mcp = [bool]$spec.capabilities.mcp
        }
    })
    $directory = $null
    if ($installation -and $installation.agentPath) { $directory = Split-Path (Split-Path ([string]$installation.agentPath)) }
    elseif ($Request -and $Request.shadowbotDir) { $directory = Assert-UiPath $Request.shadowbotDir }
    else {
        if (!$script:Ui.Detected) {
            $script:Ui.Detected = @{ value = $null }
            try { $script:Ui.Detected.value = @(Get-ShadowBotDirectoryCandidates $manifest | Select-Object -First 1)[0] } catch { }
        }
        $directory = $script:Ui.Detected.value
    }
    $attachment = $null
    if ($installed -and $installation.agentPath) {
        $attachment = Get-ShadowBotAttachment $state $installation.agentPath $selected $bundled.id
    }
    $preference = $null
    $preferences = Join-Path $state 'preferences.json'
    if (Test-Path -LiteralPath $preferences -PathType Leaf) {
        try { $preference = (Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json).app } catch { }
    }
    $job = $script:Ui.Job
    [ordered]@{
        windows = $IsWindows
        installed = $installed
        canUninstall = (Test-Path -LiteralPath $state) -or (Test-Path -LiteralPath (Join-Path $project '.tools')) -or (Test-Path -LiteralPath (Join-Path $project 'dist')) -or (Test-Path -LiteralPath (Join-Path $project 'node_modules'))
        ready = $installed -and (Test-Path -LiteralPath (Join-Path $state 'shadowbot-pi.exe') -PathType Leaf)
        problem = $problem
        selected = $selected
        recoveryPending = @('activation.pending.json', 'switch.pending.json' | Where-Object { Test-Path -LiteralPath (Join-Path $state $_) }).Count -gt 0
        upstreamCheckedAt = $script:Ui.Upstream.checkedAt
        harnesses = $harnesses
        shadowbot = [ordered]@{ directory = $directory; version = (Get-UiShadowBotVersion $directory); attachment = $attachment }
        home = $state
        app = $preference
        job = if ($job -and !$job.Done) { [ordered]@{ id = $job.Id; cmd = $job.Cmd; harness = $job.Harness; localOnly = $job.LocalOnly } } else { $null }
    }
}

function Start-UiJob($Request) {
    if ($script:Ui.Job -and !$script:Ui.Job.Done) { throw '已有任务在运行，等它结束后再试。' }
    $arguments = ConvertTo-UiJobArguments $Request
    $encoded = New-UiEncodedCommand (Join-Path $script:Ui.Project 'switch.ps1') $arguments
    $shell = (Get-Process -Id $PID).Path
    # EncodedCommand otherwise serializes redirected host/progress streams as CLIXML.
    $info = New-UiProcessInfo $shell @('-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    $waitControl = Open-SwitchWaitControl "Local\ShadowBotSwitch-Wait-$([Guid]::NewGuid())" -Create
    $info.Environment['SHADOWBOT_SWITCH_WAIT_CONTROL'] = $waitControl.Name
    try { $process = [Diagnostics.Process]::Start($info) }
    catch { Close-SwitchWaitControl $waitControl; throw }
    $process.StandardInput.Close()
    $script:Ui.Upstream = $null
    $script:Ui.JobCount++
    $script:Ui.Job = @{
        LocalOnly = [bool]$Request.localOnly; Id = $script:Ui.JobCount; Cmd = [string]$Request.cmd; Harness = [string]$Request.harness
        Process = $process; WaitControl = $waitControl; Lines = [Collections.Generic.List[string]]::new()
        Out = $process.StandardOutput.ReadLineAsync(); Err = $process.StandardError.ReadLineAsync()
        Done = $false; ExitCode = $null; Stopped = $false; Started = [DateTime]::UtcNow; ExitedAt = $null
    }
    $script:Ui.Job.Id
}

# Collects finished line reads without blocking, so the server keeps answering.
function Update-UiJob($Job) {
    if (!$Job -or $Job.Done) { return }
    foreach ($key in 'Out', 'Err') {
        $reader = if ($key -eq 'Out') { $Job.Process.StandardOutput } else { $Job.Process.StandardError }
        while ($Job[$key] -and $Job[$key].IsCompleted) {
            $line = $null
            try { $line = $Job[$key].GetAwaiter().GetResult() } catch { }
            if ($null -eq $line) { $Job[$key] = $null; break }
            $Job.Lines.Add((ConvertTo-UiPlainText $line))
            $Job[$key] = $reader.ReadLineAsync()
        }
    }
    if ($Job.Process.HasExited) {
        if (!$Job.ExitedAt) { $Job.ExitedAt = [DateTime]::UtcNow }
        # A process the task left running can hold the pipes open; stop waiting shortly after exit.
        if ((!$Job.Out -and !$Job.Err) -or ([DateTime]::UtcNow - $Job.ExitedAt).TotalSeconds -gt 3) {
            $Job.ExitCode = $Job.Process.ExitCode
            $Job.Stopped = $Job.WaitControl.Stopped.WaitOne(0)
            $Job.Done = $true
            Close-SwitchWaitControl $Job.WaitControl
            $Job.Process.Dispose()
        }
    }
}

function Stop-UiJob($Job) {
    if (!$Job -or $Job.Done -or !$Job.WaitControl.Waiting.WaitOne(0)) { return $false }
    # This is only a request. A late request is harmless: the child acknowledges
    # it only inside the initial wait, never after installation changes begin.
    [void]$Job.WaitControl.Cancel.Set()
    return $true
}

function Get-UiJobProgress($Request) {
    $job = $script:Ui.Job
    if (!$job -or $job.Id -ne [int]$Request.id) { throw '找不到这个任务，界面服务可能已经重启。' }
    Update-UiJob $job
    $since = [Math]::Max(0, [Math]::Min([int]$Request.since, $job.Lines.Count))
    [ordered]@{
        id = $job.Id; cmd = $job.Cmd; harness = $job.Harness
        lines = @($job.Lines.GetRange($since, $job.Lines.Count - $since))
        cursor = $job.Lines.Count
        done = $job.Done; exitCode = $job.ExitCode; stopped = $job.Stopped
        waiting = !$job.Done -and $job.WaitControl.Waiting.WaitOne(0)
        elapsed = [int]([DateTime]::UtcNow - $job.Started).TotalSeconds
    }
}

function Select-UiFolder([ValidateSet('skill','app')]$Purpose = 'skill') {
    if (!$IsWindows) { throw '文件夹选择框只在 Windows 上可用，请直接填写路径。' }
    $script = @'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = '选择包含 SKILL.md 的文件夹'; UseDescriptionForTitle = $true }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
'@
    if ($Purpose -ceq 'app') { $script = $script.Replace('选择包含 SKILL.md 的文件夹', '选择影刀应用根目录') }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $result = Invoke-UiProcess (Get-Process -Id $PID).Path @('-STA', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', $encoded) 900
    $result.stdout.Trim()
}

# Reads only the name from SKILL.md front matter; `skills add` does the real validation.
function Get-UiSkillPreview($Path) {
    $folder = Assert-UiPath $Path
    if (!(Test-Path -LiteralPath $folder -PathType Container)) { throw '文件夹不存在。' }
    $file = Join-Path $folder 'SKILL.md'
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw '这个文件夹里没有 SKILL.md。' }
    $lines = @(Get-Content -LiteralPath $file -TotalCount 64 -Encoding utf8)
    if (!$lines.Count -or $lines[0].Trim() -ne '---') { throw 'SKILL.md 开头缺少 --- 信息块。' }
    for ($i = 1; $i -lt $lines.Count -and $lines[$i].Trim() -ne '---'; $i++) {
        if ($lines[$i] -match '^name:\s*(.+?)\s*$') { return $Matches[1].Trim('"', "'") }
    }
    throw 'SKILL.md 里没有 name。'
}

function Open-UiPath($Kind, $Path) {
    if (!$IsWindows) { throw '只在 Windows 上可以打开文件夹。' }
    $target = Assert-UiPath $Path
    if ($Kind -ceq 'folder') {
        # A file is only selected in Explorer, never opened, so nothing runs.
        if (Test-Path -LiteralPath $target -PathType Container) { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$target`""; return }
        if (Test-Path -LiteralPath $target -PathType Leaf) { Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$target`""; return }
        throw "路径不存在：$target"
    }
    if ($Kind -ceq 'rules') {
        if ((Split-Path -Leaf $target) -ne 'AGENTS.md' -or !(Test-Path -LiteralPath $target -PathType Leaf)) { throw '只能打开存在的 AGENTS.md。' }
        Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$target`""
        return
    }
    throw '不支持的打开方式。'
}

function Invoke-UiUpdateCheck($Request) {
    if ($script:Ui.Job -and !$script:Ui.Job.Done) { throw '任务运行中，结束后再检查更新。' }
    $mirror = if ($Request.ContainsKey('mirror')) { Assert-UiMirror $Request.mirror }
    $specs = @(Get-HarnessRegistry $script:Ui.Project)
    $report = Get-HarnessUpdateReport $script:Ui.Project $script:Ui.State $specs (Get-ToolchainSource $mirror)
    $cache = @{ checkedAt = $report.checkedAt; items = @{} }
    foreach ($item in $report.harnesses) {
        $message = if ($item.status -eq 'error') { '更新检查失败，请检查下载源或仅按本地源码重建。' } else { $item.message }
        $safe = @{ status = $item.status; message = $message }
        foreach ($key in 'candidate','latest','majorAvailable') {
            if ($item[$key]) { Assert-SemVer $item[$key] }
            $safe[$key] = $item[$key]
        }
        $cache.items[$item.id] = $safe
    }
    $script:Ui.Upstream = $cache
    $cache
}

function Invoke-UiSave($Command, $Request) {
    Assert-UiIdle
    $arguments = @($Command, 'save', '--expect', (Assert-UiDigest $Request.expect), '--json') + (Get-UiScopeArguments $Request)
    if ($Command -ceq 'rules') {
        $arguments += @('--scope', (Assert-UiRuleScope $Request.scope))
        if ($Request.content -isnot [string] -or $Request.content.Length -gt 128KB) { throw '规则文本无效或过长。' }
        $text = $Request.content
    } else {
        $patch = @{ version = 1 }
        if ($Request.ContainsKey('thinkingCommand')) {
            if ($null -ne $Request.thinkingCommand -and $Request.thinkingCommand -isnot [bool]) { throw 'thinkingCommand 需要布尔值。' }
            $patch.thinkingCommand = $Request.thinkingCommand
        }
        if ($Request.ContainsKey('mcpPermission')) {
            if ($Request.mcpPermission -isnot [array] -or $Request.mcpPermission.Count -gt 200) { throw '授权规则最多 200 条。' }
            $patch.mcpPermission = @(foreach ($row in $Request.mcpPermission) {
                if ($row.pattern -isnot [string] -or $row.action -isnot [string] -or $row.action -cnotin 'allow','ask','deny') { throw '授权规则无效。' }
                @{ pattern = $row.pattern; action = $row.action }
            })
        }
        $text = ConvertTo-Json -InputObject $patch -Depth 5
    }
    $stage = New-UiStageFile $text
    try { Invoke-UiControl ($arguments + @('--from', $stage.path)) }
    finally { Remove-UiStageFile $stage.path }
}

function Invoke-UiApi([string]$Path, $Request) {
    switch -CaseSensitive ($Path) {
        '/api/rules/save' { return Invoke-UiSave 'rules' $Request }
        '/api/settings/save' { return Invoke-UiSave 'settings' $Request }
        '/api/config/stage' {
            Assert-UiIdle
            $stage = New-UiStageFile $Request.content
            return @{ id = $stage.id; bytes = $stage.bytes }
        }
        '/api/config/discard' {
            Assert-UiIdle
            Remove-UiStageFile (Get-UiStagePath $Request.stage)
            return @{ ok = $true }
        }
        '/api/config/import' {
            if ($Request.replace -isnot [bool] -or $Request.dryRun -isnot [bool]) { throw 'replace 和 dryRun 需要布尔值。' }
            if (!$Request.dryRun) { Assert-UiIdle }
            $stage = Get-UiStagePath $Request.stage
            $arguments = @('config', 'import', $stage, '--json') + (Get-UiScopeArguments $Request)
            if ($Request.replace) { $arguments += '--replace' }
            if ($Request.dryRun) { $arguments += '--dry-run' }
            $result = Invoke-UiControl $arguments
            if (!$Request.dryRun -and $result.exitCode -eq 0) { Remove-UiStageFile $stage }
            return $result
        }
        '/api/config/export' {
            Assert-UiIdle
            $scope = @(Get-UiScopeArguments $Request)
            $stage = New-UiStageFile ''
            try {
                $result = Invoke-UiControl (@('config', 'export', $stage.path, '--replace', '--json') + $scope)
                $result.content = [IO.File]::ReadAllText($stage.path)
                $label = if ($Request.app) { (Split-Path -Leaf $Request.app) -replace '[^\p{L}\p{N}_-]','_' } else { '全局' }
                $result.fileName = "shadowbot-config-$label-$(Get-Date -Format 'yyyyMMdd-HHmm').json"
                return $result
            } finally { Remove-UiStageFile $stage.path }
        }
        '/api/ping' { return @{ ok = $true } }
        '/api/updates/check' { return Invoke-UiUpdateCheck $Request }
        '/api/state' { return Get-UiState $Request }
        '/api/run' { return Invoke-UiControl (ConvertTo-UiCommand $Request) }
        '/api/jobs/start' { return @{ id = Start-UiJob $Request } }
        '/api/jobs/poll' { return Get-UiJobProgress $Request }
        '/api/jobs/stop' {
            if (!$script:Ui.Job -or $script:Ui.Job.Id -ne [int]$Request.id) { throw '找不到这个任务，界面服务可能已经重启。' }
            return @{ accepted = Stop-UiJob $script:Ui.Job }
        }
        '/api/pick-folder' { return @{ path = Select-UiFolder ($Request.purpose ?? 'skill') } }
        '/api/skill-preview' { return @{ name = Get-UiSkillPreview $Request.path } }
        '/api/open' { Open-UiPath $Request.kind $Request.path; return @{ ok = $true } }
    }
    throw [Collections.Generic.KeyNotFoundException]::new('找不到这个接口。')
}

function Send-UiBytes($Response, [int]$Status, [string]$ContentType, [byte[]]$Bytes) {
    $Response.StatusCode = $Status
    $Response.ContentType = $ContentType
    $Response.AddHeader('Cache-Control', 'no-store')
    $Response.AddHeader('X-Content-Type-Options', 'nosniff')
    $Response.AddHeader('Referrer-Policy', 'no-referrer')
    $Response.ContentLength64 = $Bytes.Length
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
}

function Send-UiJson($Response, [int]$Status, $Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 10 -Compress
    Send-UiBytes $Response $Status 'application/json; charset=utf-8' ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

# ConvertFrom-Json in early PowerShell 7 turns date-shaped strings into
# DateTime and substitutes invalid surrogate pairs. Keep editor text exact.
function Read-UiEditorStrings($Path, $Text, $Body) {
    $doc = [Text.Json.JsonDocument]::Parse([string]$Text)
    try {
        if ($Path -ceq '/api/rules/save') {
            $Body.content = $doc.RootElement.GetProperty('content').GetString()
        } elseif ($Body.mcpPermission -is [array]) {
            $rows = $doc.RootElement.GetProperty('mcpPermission')
            for ($i = 0; $i -lt $Body.mcpPermission.Count; $i++) {
                $Body.mcpPermission[$i].pattern = $rows[$i].GetProperty('pattern').GetString()
            }
        }
    } catch { throw '内容包含无法编码的字符，或字段不是有效字符串。' }
    finally { $doc.Dispose() }
}

function Invoke-UiRequest($Context) {
    $request = $Context.Request
    $response = $Context.Response
    try {
        $path = $request.Url.AbsolutePath
        if ($request.HttpMethod -ceq 'GET' -and $script:UiFiles.ContainsKey($path)) {
            $file = $script:UiFiles[$path]
            $response.AddHeader('Content-Security-Policy', $script:UiPolicy)
            Send-UiBytes $response 200 $file[1] ([IO.File]::ReadAllBytes((Join-Path $script:Ui.Project "ui/$($file[0])")))
            return
        }
        if ($request.HttpMethod -cne 'POST' -or !$path.StartsWith('/api/')) { Send-UiJson $response 404 @{ error = '找不到这个地址。' }; return }
        if ($path -cne '/api/bye' -and !(Test-UiToken $script:Ui.Token $request.Headers['X-Token'])) { Send-UiJson $response 403 @{ error = '页面已过期，请重新运行 ui.ps1。' }; return }
        $limit = if ($path -ceq '/api/config/stage') { 32MB } else { 1MB }
        if ($request.ContentLength64 -gt $limit) { Send-UiJson $response 413 @{ error = '请求太大。' }; return }
        $bodyBytes = [IO.MemoryStream]::new()
        try {
            $chunk = [byte[]]::new(65536)
            while (($count = $request.InputStream.Read($chunk, 0, $chunk.Length)) -gt 0) {
                if ($bodyBytes.Length + $count -gt $limit) { Send-UiJson $response 413 @{ error = '请求太大。' }; return }
                $bodyBytes.Write($chunk, 0, $count)
            }
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($bodyBytes.GetBuffer(), 0, [int]$bodyBytes.Length)
        } finally { $bodyBytes.Dispose() }
        if ($path -ceq '/api/bye') {
            # sendBeacon cannot set headers, so the token comes as the body. A reload pings
            # again right away; a closed window lets the server stop within a few seconds.
            if (Test-UiToken $script:Ui.Token $text.Trim()) { $script:Ui.LastSeen = [DateTime]::UtcNow.AddSeconds(5 - $script:UiIdleSeconds) }
            Send-UiJson $response 200 @{ ok = $true }
            return
        }
        $script:Ui.LastSeen = [DateTime]::UtcNow
        $body = if ($path -ceq '/api/config/stage') { @{ content = $text } } elseif ($text.Trim()) { ConvertFrom-Json -InputObject $text -AsHashtable } else { @{} }
        if ($body -isnot [Collections.IDictionary]) { throw '请求格式无效。' }
        if ($path -cin '/api/rules/save', '/api/settings/save') { Read-UiEditorStrings $path $text $body }
        Send-UiJson $response 200 (Invoke-UiApi $path $body)
    } catch [Collections.Generic.KeyNotFoundException] {
        Send-UiJson $response 404 @{ error = $_.Exception.Message }
    } catch {
        try { Send-UiJson $response 400 @{ error = $_.Exception.Message } } catch { }
    } finally {
        try { $response.Close() } catch { }
    }
}

function Get-UiFreePort {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $probe.Start()
    try { $probe.LocalEndpoint.Port } finally { $probe.Stop() }
}

function Open-UiWindow([string]$Url) {
    if ($IsWindows) {
        $edge = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) | Where-Object { $_ } |
            ForEach-Object { Join-Path $_ 'Microsoft\Edge\Application\msedge.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ($edge) { Start-Process -FilePath $edge -ArgumentList @("--app=$Url", '--window-size=1280,820'); return }
    }
    Start-Process $Url
}

function Test-UiIdle {
    if ($script:Ui.Job -and !$script:Ui.Job.Done) { return $false }
    ([DateTime]::UtcNow - $script:Ui.LastSeen).TotalSeconds -gt $script:UiIdleSeconds
}

function Start-UiServer([string]$Project, [switch]$NoBrowser) {
    $script:Ui = @{
        Project = $Project; State = (Join-Path $Project '.shadowbot-switch'); Token = (New-UiToken)
        StageFiles = [Collections.Generic.HashSet[string]]::new()
        # Give the window time to open before the first heartbeat is expected.
        LastSeen = [DateTime]::UtcNow.AddSeconds(60); Job = $null; JobCount = 0; Detected = $null
    }
    Clear-UiStage ([TimeSpan]::FromHours(24))
    $listener = $null
    for ($attempt = 0; $attempt -lt 5 -and !$listener; $attempt++) {
        # localStorage belongs to the origin. Prefer a repeatable port for this project.
        $port = if ($attempt -eq 0) {
            $digest = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Project.ToLowerInvariant()))
            49152 + ([BitConverter]::ToUInt16($digest, 0) % 16384)
        } else { Get-UiFreePort }
        $candidate = [Net.HttpListener]::new()
        # http.sys only accepts Host: localhost here, which also blocks DNS rebinding.
        $candidate.Prefixes.Add("http://localhost:$port/")
        try { $candidate.Start(); $listener = $candidate } catch { $candidate.Close() }
    }
    if (!$listener) { throw '无法在本机开启界面服务端口。' }
    $url = "http://localhost:$port/#$($script:Ui.Token)"
    Write-Host "ShadowBot Switch 界面：http://localhost:$port/"
    Write-Host '关闭界面窗口后服务会自动退出，也可以按 Ctrl+C 退出。'
    if ($NoBrowser) { Write-Host "在浏览器中打开：$url" } else { Open-UiWindow $url }
    try {
        while ($listener.IsListening) {
            $pending = $listener.BeginGetContext($null, $null)
            while (!$pending.AsyncWaitHandle.WaitOne(1000)) {
                Update-UiJob $script:Ui.Job
                if (Test-UiIdle) { return }
            }
            Invoke-UiRequest ($listener.EndGetContext($pending))
        }
    } finally {
        $job = $script:Ui.Job
        if ($job -and !$job.Done) {
            # Stopping halfway through a switch would leave recovery work; let it finish.
            Write-Host '正在等待当前任务结束，结束后自动退出…'
            $shown = $job.Lines.Count
            while (!$job.Done) {
                Update-UiJob $job
                for (; $shown -lt $job.Lines.Count; $shown++) { Write-Host $job.Lines[$shown] }
                Start-Sleep -Milliseconds 200
            }
        }
        $listener.Close()
        Clear-UiStage ([TimeSpan]::Zero) -OwnedOnly
    }
}
