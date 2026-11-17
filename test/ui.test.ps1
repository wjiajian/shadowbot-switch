$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot
. (Join-Path $repository 'scripts/ui-server.ps1')
$base = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
$root = Join-Path $base "shadowbot-ui-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $root | Out-Null
$server = $null

function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
    try { & $Action } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw "$Message Got: $($_.Exception.Message)" }
        return
    }
    throw "$Message It did not throw."
}

try {
    $state = Join-Path $root 'state'
    New-Item -ItemType Directory -Path $state | Out-Null
    $script:Ui = @{ Project = $repository; State = $state; Token = (New-UiToken); Job = $null; JobCount = 0; Detected = @{ value = $null } }

    # Tokens are random hex and compared in full.
    $token = New-UiToken
    if ($token -cnotmatch '^[0-9a-f]{64}$' -or $token -eq (New-UiToken)) { throw 'Tokens must be 64 random hex characters.' }
    if (!(Test-UiToken $token $token) -or (Test-UiToken $token ($token.Substring(0, 63) + 'x')) -or (Test-UiToken $token $token.Substring(1)) -or (Test-UiToken $token '') -or (Test-UiToken '' '')) {
        throw 'Token comparison accepted a wrong token.'
    }

    # Only whitelisted commands reach the control program, always with explicit arguments.
    $arguments = ConvertTo-UiCommand @{ cmd = 'skills.list' }
    if (($arguments -join '|') -cne 'skills|list|--json|--global') { throw "Unscoped requests must use --global: $($arguments -join ' ')" }
    $arguments = ConvertTo-UiCommand @{ cmd = 'skills.enable'; name = 'report-export'; app = 'C:\Apps\finance' }
    if (($arguments -join '|') -cne 'skills|enable|report-export|--json|--app|C:\Apps\finance') { throw "Scoped requests lost their app: $($arguments -join ' ')" }
    $arguments = ConvertTo-UiCommand @{ cmd = 'mcp.add'; name = 'local-tools'; transport = 'stdio'; command = 'node'; args = @('server.js', '--app', ' '); cwd = 'C:\Tools'; permission = 'ask' }
    if (($arguments -join '|') -cne 'mcp|add|local-tools|--command|node|--arg|server.js|--arg|--app|--cwd|C:\Tools|--permission|ask|--json|--global') {
        throw "MCP arguments must stay paired with --arg: $($arguments -join ' ')"
    }
    $arguments = ConvertTo-UiCommand @{ cmd = 'mcp.add'; name = 'docs'; transport = 'http'; url = 'https://example.com/mcp' }
    if (($arguments -join '|') -cne 'mcp|add|docs|--url|https://example.com/mcp|--json|--global') { throw "HTTP MCP arguments are wrong: $($arguments -join ' ')" }
    $arguments = ConvertTo-UiCommand @{ cmd = 'mcp.test' }
    if (($arguments -join '|') -cne 'mcp|test|--json|--global') { throw 'mcp.test without a name must test every MCP.' }
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'apps.select' } } '不支持的操作' 'Commands outside the whitelist must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'Skills.List' } } '不支持的操作' 'Command names must match exactly.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'skills.remove'; name = '--global' } } '名称无效' 'Option-looking skill names must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'skills.enable'; name = 'Report Export' } } '名称无效' 'Skill names must follow the CLI rule.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'mcp.remove'; name = 'a b' } } '名称无效' 'MCP names must follow the CLI rule.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'skills.add'; path = 'skills\report-export' } } '完整路径' 'Relative skill paths must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'skills.list'; app = 'C:\Apps\a"b' } } '完整路径' 'Paths with quotes must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'mcp.add'; name = 'docs'; transport = 'http'; url = 'file:///C:/x' } } 'http' 'Non-HTTP MCP URLs must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'mcp.add'; name = 'docs'; transport = 'pipe' } } 'stdio' 'Unknown MCP transports must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'mcp.add'; name = 'docs'; transport = 'http'; url = 'https://x'; permission = 'always' } } '授权' 'Unknown permissions must be refused.'
    Assert-Throws { ConvertTo-UiCommand @{ cmd = 'config.open'; target = 'settings' } } 'mcp 或 skills' 'Only the two config files may be opened.'
    if ((Assert-UiPath '  "C:\Skills\demo"  ') -cne 'C:\Skills\demo') { throw 'Pasted paths should lose surrounding quotes and spaces.' }

    # Long tasks always wait with a timeout, and repair stays an array.
    $arguments = ConvertTo-UiJobArguments @{ cmd = 'repair'; shadowbotDir = 'D:\ShadowBot' }
    if ($arguments -isnot [array] -or ($arguments -join '|') -cne "repair|--wait|--timeout|$script:UiWaitSeconds") { throw "Repair arguments are wrong: $($arguments -join ' ')" }
    $arguments = ConvertTo-UiJobArguments @{ cmd = 'use'; harness = 'pi'; shadowbotDir = 'D:\ShadowBot' }
    if (($arguments -join '|') -cne "use|pi|--wait|--timeout|$script:UiWaitSeconds|--shadowbot-dir|D:\ShadowBot") { throw "Use arguments are wrong: $($arguments -join ' ')" }
    $arguments = ConvertTo-UiJobArguments @{ cmd = 'update'; harness = 'pi' }
    if (($arguments -join '|') -cne "update|pi|--wait|--timeout|$script:UiWaitSeconds") { throw "Update arguments are wrong: $($arguments -join ' ')" }
    Assert-Throws { ConvertTo-UiJobArguments @{ cmd = 'use'; harness = 'repair' } } '未知 harness' 'Job harnesses must come from the registry.'
    Assert-Throws { ConvertTo-UiJobArguments @{ cmd = 'uninstall' } } '不支持的任务' 'Unknown jobs must be refused.'

    # Arguments survive the -EncodedCommand round trip literally, including quote look-alikes.
    if ((ConvertTo-UiQuoted "it's") -cne "'it''s'" -or (ConvertTo-UiQuoted "a$([char]0x2019)b") -cne "'a$([char]0x2019)$([char]0x2019)b'") { throw 'Quoting must double every single quote character.' }
    $echo = Join-Path $root "echo's.ps1"
    Set-Content -LiteralPath $echo -Encoding utf8 -Value 'foreach ($item in $args) { [Console]::Out.WriteLine("<$item>") }'
    $values = @("it's", "a$([char]0x2018)b$([char]0x201B)c", '$(Write-Output injected)', "'; Write-Output injected; '", '中文 路径', '--app')
    $script:Ui.Project = $root
    $result = Invoke-UiProcess (Get-Process -Id $PID).Path @('-NoProfile', '-NonInteractive', '-EncodedCommand', (New-UiEncodedCommand $echo $values)) 60
    $script:Ui.Project = $repository
    $expected = ($values | ForEach-Object { "<$_>" }) -join "`n"
    if ($result.exitCode -ne 0 -or ($result.stdout.Trim() -replace "`r", '') -cne $expected) { throw "Encoded arguments changed on the way: $($result.stdout) $($result.stderr)" }
    if ((ConvertTo-UiPlainText "$([char]27)[31mred$([char]27)[0m") -cne 'red') { throw 'ANSI colors must be removed from output.' }

    # Skill preview reads only the front matter name.
    $skill = Join-Path $root 'report-export'
    New-Item -ItemType Directory -Path $skill | Out-Null
    Assert-Throws { Get-UiSkillPreview $skill } 'SKILL.md' 'A folder without SKILL.md must be reported.'
    Set-Content -LiteralPath (Join-Path $skill 'SKILL.md') -Encoding utf8 -Value "# report"
    Assert-Throws { Get-UiSkillPreview $skill } '---' 'SKILL.md without front matter must be reported.'
    Set-Content -LiteralPath (Join-Path $skill 'SKILL.md') -Encoding utf8 -Value "---`ndescription: export`nname: 'report-export'`n---`n# report"
    if ((Get-UiSkillPreview $skill) -cne 'report-export') { throw 'Skill preview did not read the name.' }
    Assert-Throws { Get-UiSkillPreview (Join-Path $root 'missing') } '不存在' 'A missing folder must be reported.'

    # State works before installation and follows the install record afterwards.
    $view = Get-UiState @{ shadowbotDir = 'D:\ShadowBot' }
    $pi = @($view.harnesses | Where-Object id -eq 'pi')[0]
    if ($view.installed -or $view.ready -or $view.selected -cne 'original' -or $pi.installed -or $view.shadowbot.directory -cne 'D:\ShadowBot') { throw 'State before installation is wrong.' }
    Assert-Throws { Get-UiState @{ shadowbotDir = 'ShadowBot' } } '完整路径' 'A relative ShadowBot directory must be refused.'
    $shadowbotHome = Join-Path $root 'ShadowBot'
    @{ agentPath = (Join-Path (Join-Path $shadowbotHome 'agent') 'opencode.exe'); harnesses = @{ pi = @{ version = '1.5.2' } } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $state 'install.json')
    @{ mode = 'pi' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state 'backend.json')
    Set-Content -LiteralPath (Join-Path $state 'switch.pending.json') -Value '{}'
    $view = Get-UiState @{ shadowbotDir = 'D:\Other' }
    $pi = @($view.harnesses | Where-Object id -eq 'pi')[0]
    if (!$view.installed -or $view.ready -or $view.selected -cne 'pi' -or !$pi.selected -or $pi.version -cne '1.5.2' -or !$view.recoveryPending) { throw 'State after installation is wrong.' }
    if ($view.shadowbot.directory -cne $shadowbotHome) { throw 'The install record must decide the ShadowBot directory.' }
    Assert-Throws { Invoke-UiApi '/api/run' @{ cmd = 'skills.list' } } '安装尚未就绪' 'Management commands need the installed control program.'
    Assert-Throws { Invoke-UiApi '/api/nope' @{} } '找不到' 'Unknown endpoints must be refused.'

    # Real child processes exercise cancellation without touching ShadowBot.
    $jobProject = Join-Path $root 'jobs'
    New-Item -ItemType Directory -Path $jobProject | Out-Null
    Copy-Item -LiteralPath (Join-Path $repository 'harnesses') -Destination $jobProject -Recurse
    Copy-Item -LiteralPath (Join-Path $repository 'scripts/processes.ps1') -Destination $jobProject
    Set-Content -LiteralPath (Join-Path $jobProject 'switch.ps1') -Encoding utf8 -Value @'
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'processes.ps1')
function Get-SwitchProcesses {
    if (Test-Path (Join-Path $PSScriptRoot 'running')) {
        return [pscustomobject]@{ Id = 123; ProcessName = 'fixture'; Path = 'fixture.exe' }
    }
    # Pause after the last process snapshot, before the waiting flag resets.
    if (Test-Path (Join-Path $PSScriptRoot 'race')) {
        Set-Content (Join-Path $PSScriptRoot 'snapshot') 'ready'
        while (!(Test-Path (Join-Path $PSScriptRoot 'release'))) { Start-Sleep -Milliseconds 20 }
    }
}
try {
    $timeout = if (Test-Path (Join-Path $PSScriptRoot 'timeout')) { 1 } else { 15 }
    Wait-SwitchProcesses -Wait -TimeoutSeconds $timeout
    Set-Content (Join-Path $PSScriptRoot 'changed') 'mutation started'
    if (Test-Path (Join-Path $PSScriptRoot 'second')) {
        Set-Content (Join-Path $PSScriptRoot 'running') 'busy again'
        Wait-SwitchProcesses -Wait -TimeoutSeconds 15
    }
    while (!(Test-Path (Join-Path $PSScriptRoot 'finish'))) { Start-Sleep -Milliseconds 20 }
    exit 0
} catch { Write-Host $_.Exception.Message; exit 1 }
'@
    function Wait-TestJob([scriptblock]$Condition) {
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ($true) {
            Update-UiJob $script:Ui.Job
            if (& $Condition) { return }
            if ([DateTime]::UtcNow -gt $deadline) { throw "Timed out waiting for fixture job: $($script:Ui.Job.Lines -join ' ')" }
            Start-Sleep -Milliseconds 30
        }
    }
    function Start-TestJob([string[]]$Flags, [string]$Command = 'use') {
        foreach ($name in 'running', 'race', 'snapshot', 'release', 'changed', 'finish', 'timeout', 'second') {
            $path = Join-Path $jobProject $name
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
        }
        foreach ($name in $Flags) { Set-Content -LiteralPath (Join-Path $jobProject $name) 'fixture' }
        [void](Start-UiJob @{ cmd = $Command; harness = 'original' })
    }
    $script:Ui.Project = $jobProject
    Start-TestJob @('running')
    Wait-TestJob { (Get-UiJobProgress @{ id = $script:Ui.Job.Id }).waiting }
    if (!(Invoke-UiApi '/api/jobs/stop' @{ id = $script:Ui.Job.Id }).accepted) { throw 'A waiting job must accept cancellation.' }
    Wait-TestJob { $script:Ui.Job.Done }
    $progress = Get-UiJobProgress @{ id = $script:Ui.Job.Id }
    if (!$progress.stopped -or $progress.waiting -or $progress.exitCode -eq 0 -or (Test-Path (Join-Path $jobProject 'changed'))) { throw 'Cancellation must be acknowledged before any mutation.' }

    # A cancellation racing with the final process snapshot must not kill the job.
    Start-TestJob @('running', 'race')
    Wait-TestJob { (Get-UiJobProgress @{ id = $script:Ui.Job.Id }).waiting }
    Remove-Item -LiteralPath (Join-Path $jobProject 'running')
    Wait-TestJob { Test-Path (Join-Path $jobProject 'snapshot') }
    if (!(Stop-UiJob $script:Ui.Job)) { throw 'Race fixture must still advertise waiting.' }
    Set-Content (Join-Path $jobProject 'release') 'continue'
    Wait-TestJob { Test-Path (Join-Path $jobProject 'changed') }
    $progress = Get-UiJobProgress @{ id = $script:Ui.Job.Id }
    if ($progress.waiting -or $progress.stopped -or (Stop-UiJob $script:Ui.Job)) { throw 'A late stop must not cancel a mutation or claim it stopped.' }
    Set-Content (Join-Path $jobProject 'finish') 'continue'
    Wait-TestJob { $script:Ui.Job.Done }
    if ($script:Ui.Job.Stopped -or $script:Ui.Job.ExitCode -ne 0) { throw 'A late cancellation must leave the job running to completion.' }

    # Repair waits again after changing the locator; that wait cannot be cancelled.
    Start-TestJob @('second') 'repair'
    Wait-TestJob { Test-Path (Join-Path $jobProject 'running') }
    if ((Get-UiJobProgress @{ id = $script:Ui.Job.Id }).waiting -or (Stop-UiJob $script:Ui.Job)) { throw 'A second wait after mutation must refuse cancellation.' }
    [void]$script:Ui.Job.WaitControl.Cancel.Set()
    Remove-Item -LiteralPath (Join-Path $jobProject 'running')
    Set-Content (Join-Path $jobProject 'finish') 'continue'
    Wait-TestJob { $script:Ui.Job.Done }
    if ($script:Ui.Job.Stopped -or $script:Ui.Job.ExitCode -ne 0) { throw 'Repair must ignore late requests in subsequent waits.' }

    Start-TestJob @('running', 'timeout')
    Wait-TestJob { $script:Ui.Job.Done }
    if ($script:Ui.Job.Stopped -or $script:Ui.Job.ExitCode -eq 0 -or (Test-Path (Join-Path $jobProject 'changed'))) { throw 'Timeout must fail without claiming cancellation or mutating.' }
    $script:Ui.Project = $repository

    # The real server: token required, static files carry CSP, and bye lets it exit.
    $project = Join-Path $root 'project'
    New-Item -ItemType Directory -Path (Join-Path $project 'scripts') | Out-Null
    foreach ($name in @('ui.ps1', 'ui', 'harnesses')) { Copy-Item -LiteralPath (Join-Path $repository $name) -Destination $project -Recurse }
    foreach ($name in @('ui-server.ps1', 'harnesses.ps1', 'discovery.ps1', 'processes.ps1')) { Copy-Item -LiteralPath (Join-Path $repository "scripts/$name") -Destination (Join-Path $project 'scripts') }
    $log = Join-Path $root 'server.log'
    $server = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-File', (Join-Path $project 'ui.ps1'), '-NoBrowser') -RedirectStandardOutput $log -PassThru -NoNewWindow
    $url = $null
    for ($i = 0; $i -lt 100 -and !$url; $i++) {
        Start-Sleep -Milliseconds 200
        if ((Test-Path -LiteralPath $log) -and (Get-Content -LiteralPath $log -Raw -Encoding utf8) -match '(http://localhost:\d+/)#([0-9a-f]{64})') { $url = $Matches[1]; $serverToken = $Matches[2] }
    }
    if (!$url) { throw "The UI server did not print its address: $(Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)" }
    $page = Invoke-WebRequest -Uri $url -SkipHttpErrorCheck
    if ($page.StatusCode -ne 200 -or "$($page.Headers['Content-Security-Policy'])" -notmatch "script-src 'self'" -or $page.Content -notmatch 'app.js') { throw 'The page must be served with its CSP.' }
    $denied = Invoke-WebRequest -Uri "${url}api/state" -Method Post -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck
    if ($denied.StatusCode -ne 403) { throw "Requests without the token must be refused, got $($denied.StatusCode)." }
    $wrong = Invoke-WebRequest -Uri "${url}api/state" -Method Post -Body '{}' -ContentType 'application/json' -Headers @{ 'X-Token' = ('0' * 64) } -SkipHttpErrorCheck
    if ($wrong.StatusCode -ne 403) { throw 'Requests with a wrong token must be refused.' }
    $headers = @{ 'X-Token' = $serverToken }
    $answer = Invoke-WebRequest -Uri "${url}api/state" -Method Post -Body '{}' -ContentType 'application/json' -Headers $headers -SkipHttpErrorCheck
    if ($answer.StatusCode -ne 200 -or ($answer.Content | ConvertFrom-Json).installed) { throw 'The token must unlock the state endpoint.' }
    $refused = Invoke-WebRequest -Uri "${url}api/run" -Method Post -Body '{"cmd":"apps.select"}' -ContentType 'application/json' -Headers $headers -SkipHttpErrorCheck
    if ($refused.StatusCode -ne 400 -or ($refused.Content | ConvertFrom-Json).error -notmatch '不支持的操作') { throw 'Unknown commands must come back as errors.' }
    $missing = Invoke-WebRequest -Uri "${url}../switch.ps1" -SkipHttpErrorCheck
    if ($missing.StatusCode -eq 200) { throw 'Only the UI files may be served.' }
    Invoke-WebRequest -Uri "${url}api/bye" -Method Post -Body $serverToken -ContentType 'text/plain' | Out-Null
    if (!$server.WaitForExit(15000)) { throw 'The server did not exit after the page said goodbye.' }
    $server = $null
} finally {
    if ($script:Ui.Job -and !$script:Ui.Job.Done) { try { $script:Ui.Job.Process.Kill($true); $script:Ui.Job.Process.Dispose(); Close-SwitchWaitControl $script:Ui.Job.WaitControl } catch { } }
    if ($server -and !$server.HasExited) { try { $server.Kill($true) } catch { } }
    $resolved = (Resolve-Path -LiteralPath $root).Path
    if ((Split-Path $resolved) -ne $base -or !(Split-Path -Leaf $resolved).StartsWith('shadowbot-ui-')) { throw 'Unexpected test path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
