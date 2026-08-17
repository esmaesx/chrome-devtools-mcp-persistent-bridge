[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$node = Get-Command node.exe -ErrorAction Stop

function Require-Text {
    param([string]$Text, [string]$Pattern, [string]$Message)
    if ($Text -notmatch $Pattern) { throw $Message }
}

function Require-NotText {
    param([string]$Text, [string]$Pattern, [string]$Message)
    if ($Text -match $Pattern) { throw $Message }
}

Push-Location $repositoryRoot
try {
    $requiredFiles = @(
        'README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md',
        'package.json', 'npm-shrinkwrap.json', '.github/workflows/ci.yml',
        'runtime/daemon.mjs', 'runtime/stdio-proxy.mjs', 'runtime/allow-remote-debugging.ps1',
        'runtime/start-daemon.ps1', 'runtime/status.ps1',
        'scripts/common.ps1', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/doctor.ps1',
        'scripts/lease-preflight.mjs', 'scripts/preflight-install.ps1',
        'tests/fake-chrome-server.mjs', 'tests/gateway-parent-helper.mjs', 'tests/proxy-args.mjs', 'tests/gateway-smoke.mjs',
        'docs/architecture.md', 'docs/threat-model.md', 'docs/operations.md', 'docs/release-checklist.md'
    )
    foreach ($relativePath in $requiredFiles) {
        if (-not (Test-Path -LiteralPath $relativePath -PathType Leaf)) { throw "Required file is missing: $relativePath" }
    }
    if (Test-Path -LiteralPath package-lock.json) { throw 'Use npm-shrinkwrap.json for the released exact install graph. Do not commit package-lock.json.' }

    & $node.Source --check runtime/stdio-proxy.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for runtime/stdio-proxy.mjs.' }
    & $node.Source --check runtime/daemon.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for runtime/daemon.mjs.' }
    & $node.Source --check scripts/lease-preflight.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for scripts/lease-preflight.mjs.' }
    & $node.Source --check tests/fake-chrome-server.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for tests/fake-chrome-server.mjs.' }
    & $node.Source --check tests/gateway-parent-helper.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for tests/gateway-parent-helper.mjs.' }
    & $node.Source --check tests/proxy-args.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for tests/proxy-args.mjs.' }
    & $node.Source --check tests/gateway-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed for tests/gateway-smoke.mjs.' }

    foreach ($powerShellFile in @(Get-ChildItem -LiteralPath runtime,scripts,tests -Filter '*.ps1' -File -Recurse)) {
        $tokens = $null
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($powerShellFile.FullName, [ref]$tokens, [ref]$parseErrors)
        if (@($parseErrors).Count -gt 0) { throw "PowerShell syntax check failed for $($powerShellFile.FullName): $($parseErrors[0].Message)" }
    }

    $proxy = Get-Content -LiteralPath runtime/stdio-proxy.mjs -Raw
    $daemon = Get-Content -LiteralPath runtime/daemon.mjs -Raw
    $recovery = Get-Content -LiteralPath runtime/allow-remote-debugging.ps1 -Raw
    $installer = Get-Content -LiteralPath scripts/install.ps1 -Raw
    $uninstaller = Get-Content -LiteralPath scripts/uninstall.ps1 -Raw
    $common = Get-Content -LiteralPath scripts/common.ps1 -Raw
    $readme = Get-Content -LiteralPath README.md -Raw
    $ci = Get-Content -LiteralPath .github/workflows/ci.yml -Raw

    $allowlistMatch = [regex]::Match($proxy, 'const expectedTools = new Set\(\[(?<tools>[\s\S]*?)\]\);')
    if (-not $allowlistMatch.Success) { throw 'Could not read the reviewed Chrome tool allowlist.' }
    $expectedChromeTools = @(
        'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form',
        'get_console_message', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
        'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
        'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
        'resize_page', 'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot',
        'type_text', 'upload_file', 'wait_for'
    ) | Sort-Object
    $actualChromeTools = @([regex]::Matches($allowlistMatch.Groups['tools'].Value, "'(?<name>[a-z_]+)'") | ForEach-Object { $_.Groups['name'].Value } | Sort-Object)
    if (@(Compare-Object -ReferenceObject $expectedChromeTools -DifferenceObject $actualChromeTools).Count -ne 0) {
        throw 'The Chrome tool allowlist differs from the reviewed exact set.'
    }

    foreach ($requiredPattern in @(
        'new Server\(',
        'name: ''allow_remote_debugging''',
        'setRequestHandler\(ListToolsRequestSchema',
        'setRequestHandler\(CallToolRequestSchema',
        'wasFirstCall && name === .list_pages.',
        'recoveryConsumed = true',
        "pageState === 'need_list'",
        "pageState === 'need_select'",
        'await acquireTaskLease\(\)',
        'dev-newb-chrome-control-',
        'candidate\.listen\(leasePipe\)',
        'serveLeaseStatus',
        'timingSafeEqual',
        "errorResult\('lease_busy'",
        "errorResult\('held_unknown'",
        "process\.stdin\.once\('end'",
        "process\.stdin\.once\('close'",
        "process\.stdin\.once\('error'",
        "process\.once\('uncaughtException'",
        "process\.once\('unhandledRejection'",
        'shutdownDrainMs',
        'parseGatewayArguments',
        '--lease-wait-ms',
        "parsedWait >= 750 && parsedWait <= 300_000",
        'closeLeaseCandidate',
        "observedOwner.state !== 'held'",
        'gateway_shutting_down',
        'armIdleLeaseRelease',
        'activeToolCount !== 0',
        'queuedToolCount !== 0',
        "pageState = 'need_list'",
        'daemon_absent',
        'startup_failed',
        'indeterminate_mutating_call',
        'backend tool manifest changed',
        'isAutoConnectPermissionError',
        'chrome://inspect/#remote-debugging'
    )) { Require-Text $proxy $requiredPattern "Gateway control is missing: $requiredPattern" }
    Require-NotText $proxy '(?i)--(?:http|port|host)|https?\.createServer|createServer\s*\(\s*\{|\.listen\s*\(\s*\d|WebSocketServer|createSocket\s*\(' 'The gateway must not create an HTTP, TCP, UDP, or WebSocket listener.'
    if ([regex]::Matches($proxy, '\.listen\s*\(').Count -ne 1) { throw 'The gateway must contain only its one named-pipe lease listener.' }
    Require-NotText $proxy '(?i)taskkill|Stop-Process|process\.kill|release-backend|evict|reap' 'The gateway must not kill, evict, reap, or expose forced lease release.'
    if ([regex]::Matches($proxy, 'recoveryConsumed\s*=').Count -ne 2) { throw 'Idle lease release must not reset the one-use recovery counter.' }
    if ([regex]::Matches($proxy, '\bleaseWaitMs\b').Count -ne 2) { throw 'The CLI wait bound must affect only its declaration and acquireTaskLease deadline.' }
    $argumentParse = $proxy.IndexOf('const requestedLeaseWaitMs = parseGatewayArguments', [StringComparison]::Ordinal)
    $daemonStartup = $proxy.IndexOf('await readDaemonToken()', [StringComparison]::Ordinal)
    $serverConstruction = $proxy.IndexOf('const server = new Server(', [StringComparison]::Ordinal)
    if ($argumentParse -lt 0 -or $daemonStartup -lt 0 -or $serverConstruction -lt 0 -or $argumentParse -ge $daemonStartup -or $argumentParse -ge $serverConstruction) {
        throw 'Gateway arguments must be validated before daemon access and MCP Server construction.'
    }

    foreach ($requiredPattern in @(
        'dev-newb-chrome-daemon-', 'timingSafeEqual', 'daemon_instance_id', 'expectedInstanceId',
        'expectedGeneration', 'maxTotalTimeout: timeoutFor\(name\)', 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS',
        '--no-usage-statistics', '--no-performance-crux', 'dispatched: true', 'stale_backend_generation',
        'probeLeaseStatus', '--lease-status', 'sanitizedDaemonFailure', 'daemon_absent',
        'readOnlyControlOperations', 'bypassesChromeQueue', 'rejectsBeforeChromeQueue',
        "error\('shutting_down'.*dispatched: false", "stopping && request\.operation === 'callTool'",
        "state: 'held_unknown'", "state: 'free'"
    )) { Require-Text $daemon $requiredPattern "Daemon control is missing: $requiredPattern" }
    Require-NotText $daemon '(?i)mcporter|\bnpx(?:\.cmd)?\b|--(?:http|port|host)|https?\.createServer|\.listen\s*\(\s*\d|WebSocketServer|createSocket\s*\(' 'The daemon must not use MCPorter, runtime downloads, or a network listener.'
    if ([regex]::Matches($daemon, 'client\.callTool\s*\(').Count -ne 1) { throw 'The daemon must have exactly one backend dispatch site.' }

    $statusScript = Get-Content -LiteralPath runtime\status.ps1 -Raw
    foreach ($requiredPattern in @(
        '--lease-status', 'Write-BridgeStatus', 'daemon = [ordered]', 'lease = $LeaseStatus',
        "state = 'held_unknown'", 'daemonFailureCause', 'daemon_absent', 'install_state_missing',
        'install_state_invalid', 'node_runtime_missing', 'daemon_runtime_missing', 'status_internal_error'
    )) {
        Require-Text $statusScript ([regex]::Escape($requiredPattern)) "Status reporting is missing: $requiredPattern"
    }
    Require-NotText $statusScript '(?i)Stop-Process|Start-Process|taskkill|orphan|--stop' 'Status must not stop, start, restart, or classify an orphan process.'

    $preflightScript = Get-Content -LiteralPath scripts\preflight-install.ps1 -Raw
    $leaseProbe = Get-Content -LiteralPath scripts\lease-preflight.mjs -Raw
    foreach ($requiredPattern in @('Get-BridgeInstallPreflight', 'lease_held_unknown', 'Finish or close all client sessions', 'Wait for the lease to become free')) {
        Require-Text $preflightScript ([regex]::Escape($requiredPattern)) "Install preflight is missing: $requiredPattern"
    }
    Require-NotText ($preflightScript + $leaseProbe) '(?i)Stop-Process|Start-Process|taskkill|process\.kill|--stop|release|evict|reap' 'Install preflight must not stop, kill, release, evict, or reap a process or lease.'

    foreach ($requiredPattern in @(
        'Get-AuthenticodeSignature',
        'GetClass\(\$windowHandle\) -ne ''Chrome_WidgetWin_1''',
        'GetWindow\(\$windowHandle, 4\)',
        'ProcessStartTimeUtc',
        'ControlType\]::Document',
        'blocked_web_content',
        'blocked_dialog_changed',
        'invoke_error_dialog_closed_indeterminate',
        'dialog_changed_or_replaced',
        'invoked_dialog_closed'
    )) { Require-Text $recovery $requiredPattern "Recovery provenance control is missing: $requiredPattern" }
    Require-NotText $recovery '(?i)mouse_event|SetCursorPos|SendInput|left_click' 'Recovery must not contain generic or coordinate input.'

    foreach ($requiredPattern in @(
        'InstallAgentGuidance', 'ReplaceExistingChromeMcp', 'npm\.cmd ci --omit=dev --ignore-scripts',
        'npm-shrinkwrap\.json', 'Set-OwnerOnlyDirectoryAcl', 'currentConfig -cne \$oldConfig',
        'config_block_sha256', 'task_action_arguments', 'task_principal_sid', 'RunLevel Limited',
        'Invoke-NodeDaemonControl', 'Build-StagedCandidatePayload', 'Move-PayloadItems',
        'Get-BridgeInstallPreflight', 'leaseProbePath', 'Install preflight refused the in-place update',
        'DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP', 'failed-payload', 'Restore old payload', 'Verify restored old payload', 'rollbackSafeForTaskRestart',
        'authenticated status is unavailable', 'if \(\$SkipScheduledTask\)', 'Unregister-ScheduledTask'
    )) { Require-Text $installer $requiredPattern "Installer control is missing: $requiredPattern" }
    Require-NotText $installer '(?i)\bnpx(?:\.cmd)?\b' 'Install and logon paths must not use npx.'
    Require-NotText $installer '--lease-wait-ms' 'The managed Codex gateway configuration must remain fail-fast.'
    $preflightInvocation = $installer.IndexOf('$installPreflight = Get-BridgeInstallPreflight', [StringComparison]::Ordinal)
    $firstTargetWrite = $installer.IndexOf('New-Item -ItemType Directory -Force -Path $InstallRoot, $CodexHome, $backupRoot', $preflightInvocation, [StringComparison]::Ordinal)
    if ($preflightInvocation -lt 0 -or $firstTargetWrite -lt 0 -or $preflightInvocation -ge $firstTargetWrite) {
        throw 'The read-only install preflight must complete before the first target write.'
    }
    foreach ($requiredPattern in @('File\]::Replace', 'File\]::Move', 'File\]::ReadAllText', 'verified-write temporary path', '\[ref\]\$Committed', '\$Committed\.Value = \$true')) {
        Require-Text $common $requiredPattern "Verified atomic write control is missing: $requiredPattern"
    }
    $stagingInvocation = $installer.IndexOf('Build-StagedCandidatePayload -PackageRoot', [StringComparison]::Ordinal)
    $stopInvocation = $installer.IndexOf('Stop-ScheduledTask -TaskName $TaskName', [StringComparison]::Ordinal)
    if ($stagingInvocation -lt 0 -or $stopInvocation -lt 0 -or $stagingInvocation -ge $stopInvocation) {
        throw 'The installer must build and validate the staged payload before it stops the old scheduled task.'
    }
    $restorePayload = $installer.IndexOf('Restore old payload', [StringComparison]::Ordinal)
    $verifyPayload = $installer.IndexOf("'Verify restored old payload'", [StringComparison]::Ordinal)
    $restartTask = $installer.IndexOf("'Restart old scheduled task'", [StringComparison]::Ordinal)
    if ($restorePayload -lt 0 -or $restartTask -lt 0 -or $restorePayload -ge $restartTask) {
        throw 'Rollback must restore the old payload before it restarts the old scheduled task.'
    }
    if ($verifyPayload -lt 0 -or $verifyPayload -ge $restartTask -or $installer -notmatch '\$payloadRollback\.Complete') {
        throw 'Rollback must verify the full old payload before it can restart the old scheduled task.'
    }
    foreach ($requiredPattern in @('config_block_sha256', 'agents_block_sha256', 'MSFT_TaskLogonTrigger', 'Get-DefaultInstallRoot', 'ReparsePoint', '--stop', 'RemoveInstalledFiles', 'Get-ExactDaemonProcesses', 'authenticated status is unavailable', 'Assert-InstallRemovalPathWithoutReparse', 'Assert-InstallRemovalTreeWithoutReparse', 'No recursive enumeration or deletion was attempted')) {
        Require-Text $uninstaller $requiredPattern "Uninstaller ownership check is missing: $requiredPattern"
    }
    $rootGuard = $uninstaller.IndexOf('if ($RemoveInstalledFiles) { Assert-InstallRemovalPathWithoutReparse -Path $InstallRoot }', [StringComparison]::Ordinal)
    $treeGuard = $uninstaller.IndexOf('Assert-InstallRemovalTreeWithoutReparse -Path $InstallRoot', $rootGuard, [StringComparison]::Ordinal)
    $recursiveRemoval = $uninstaller.LastIndexOf('Remove-Item -LiteralPath $InstallRoot -Recurse -Force', [StringComparison]::Ordinal)
    if ($rootGuard -lt 0 -or $treeGuard -lt 0 -or $recursiveRemoval -lt 0 -or $rootGuard -ge $treeGuard -or $treeGuard -ge $recursiveRemoval) {
        throw 'Uninstall must check the install root and existing ancestors before recursive enumeration or removal.'
    }

    foreach ($phrase in @(
        'Important change from the original issue comment', 'issuecomment-4965356923',
        'no HTTP/TCP control listener', 'allow_remote_debugging', 'cross-process lease with safe idle release',
        'One Codex task', '10 minutes', 'held_unknown', 'not a browser sandbox', 'all exposed Chrome tabs',
        'preflight-install.ps1', 'lease_held_unknown', 'live_gateway_present', 'daemon_absent',
        'separate Chrome profile without sensitive accounts', 'Browser content is untrusted',
        'mutating timeout or closed transport is indeterminate', 'do not replay that mutation',
        'does not revoke a Chrome remote-debugging permission', 'same user',
        'not affiliated with, endorsed by, or supported by Google, OpenAI',
        'staged installation with rollback on detected failure', 'npm-shrinkwrap.json',
        'package-local daemon uses a bearer-token', 'Usage statistics, CrUX lookups, and update checks are disabled', 'InstallAgentGuidance', 'doctor',
        'single-trust-user Windows host', 'pipe server', 'bearer token'
    )) { Require-Text $readme ([regex]::Escape($phrase)) "README security content is missing: $phrase" }

    $doctorText = Get-Content -LiteralPath scripts\doctor.ps1 -Raw
    Require-Text $doctorText ([regex]::Escape('[\\/]chrome-devtools-bridge[\\/]')) 'Doctor must detect the replaced MCPorter prototype path as a legacy Chrome bridge.'

    $package = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
    $shrinkwrapText = Get-Content -LiteralPath npm-shrinkwrap.json -Raw
    if ($package.os -notcontains 'win32' -or $package.cpu -notcontains 'x64') { throw 'package.json must declare the tested Windows x64 scope.' }
    if ([string]$package.engines.node -ne '>=24 <25') { throw 'package.json must declare the tested Node 24 range.' }
    $shrinkwrapTopVersion = '^(?:\uFEFF)?\{\s*"name"\s*:\s*"chrome-devtools-mcp-persistent-bridge"\s*,\s*"version"\s*:\s*"0\.1\.2"'
    $shrinkwrapRootVersion = '""\s*:\s*\{\s*"name"\s*:\s*"chrome-devtools-mcp-persistent-bridge"\s*,\s*"version"\s*:\s*"0\.1\.2"'
    if ([string]$package.version -ne '0.1.2' -or $shrinkwrapText -notmatch $shrinkwrapTopVersion -or $shrinkwrapText -notmatch $shrinkwrapRootVersion) {
        throw 'Package and shrinkwrap release identities must all be 0.1.2.'
    }
    foreach ($identity in @(
        @{ Text = $proxy; Pattern = "name: 'chrome-devtools-persistent-gateway', version: '0\.1\.2'"; Label = 'gateway runtime' },
        @{ Text = $daemon; Pattern = "name: 'chrome-devtools-persistent-daemon', version: '0\.1\.2'"; Label = 'daemon runtime' },
        @{ Text = $installer; Pattern = "package_version = '0\.1\.2'"; Label = 'installer state' },
        @{ Text = (Get-Content -LiteralPath tests\gateway-parent-helper.mjs -Raw); Pattern = "version: '0\.1\.2'"; Label = 'parent helper' },
        @{ Text = (Get-Content -LiteralPath tests\gateway-smoke.mjs -Raw); Pattern = "version: '0\.1\.2'"; Label = 'gateway test client' }
    )) {
        Require-Text $identity.Text $identity.Pattern "The $($identity.Label) release identity is not 0.1.2."
    }
    foreach ($pin in @{
        '@modelcontextprotocol/sdk' = '1.29.0'; 'chrome-devtools-mcp' = '1.7.0'; zod = '4.4.3'
    }.GetEnumerator()) {
        $pattern = '"' + [regex]::Escape($pin.Key) + '"\s*:\s*"' + [regex]::Escape($pin.Value) + '"'
        if ($shrinkwrapText -notmatch $pattern) { throw "Shrinkwrap root pin is missing: $($pin.Key)" }
    }

    foreach ($command in @('npm ci', 'npm test', 'npm audit')) {
        Require-Text $ci ([regex]::Escape($command)) "CI is missing required command: $command"
    }
    Require-Text $ci 'node-version: 24' 'CI must use Node 24.'

    $allText = (Get-ChildItem -File -Recurse | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\work\\' } | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) -join "`n"
    $privatePatterns = @(
        ('C:' + '\\Users\\' + 'Sahar'),
        ('sahar' + '\.esmaeel'),
        ('x0' + 'lumina0x')
    ) -join '|'
    Require-NotText $allText $privatePatterns 'Repository content contains a machine-specific or private identifier.'

    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('bridge-tests-' + [guid]::NewGuid().ToString('N'))
    $savedNodeEnv = [Environment]::GetEnvironmentVariable('NODE_ENV', 'Process')
    $savedHelperLoad = [Environment]::GetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_LOAD_HELPERS', 'Process')
    $savedFailureInjection = [Environment]::GetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP', 'Process')
    try {
        New-Item -ItemType Directory -Path $temp | Out-Null
        [Environment]::SetEnvironmentVariable('NODE_ENV', 'test', 'Process')
        [Environment]::SetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_LOAD_HELPERS', '1', 'Process')
        [Environment]::SetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP', $null, 'Process')
        . (Join-Path $repositoryRoot 'scripts/install.ps1')
        . (Join-Path $repositoryRoot 'scripts/uninstall.ps1')
        . (Join-Path $repositoryRoot 'scripts/common.ps1')
        $sample = "before`r`n$($script:ConfigBegin)`r`nowned`r`n$($script:ConfigEnd)`r`nafter`r`n"
        $owned = Get-OwnedBlockText -Text $sample -Begin $script:ConfigBegin -End $script:ConfigEnd
        if ((Get-TextSha256 -Text $owned).Length -ne 64) { throw 'Owned block hash helper failed.' }
        $removed = Remove-OwnedBlock -Text $sample -Begin $script:ConfigBegin -End $script:ConfigEnd
        if ($removed -match 'owned' -or $removed -notmatch 'before' -or $removed -notmatch 'after') { throw 'Owned block removal failed.' }
        $toml = "[mcp_servers.chrome-devtools]`r`ncommand='old'`r`n[mcp_servers.other]`r`ncommand='keep'`r`n"
        $section = Remove-TomlMcpServerSection -Text $toml -ServerName 'chrome-devtools'
        if (-not $section.Found -or $section.Text -notmatch 'mcp_servers\.other' -or $section.Text -match "command='old'") { throw 'TOML server section removal failed.' }

        $testStartScript = Join-Path $repositoryRoot 'runtime\start-daemon.ps1'
        $testPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $testArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$testStartScript`""
        $validAction = [pscustomobject]@{ Execute = $testPowerShell; Arguments = $testArguments; WorkingDirectory = $repositoryRoot }
        $validTrigger = [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } }
        $validPrincipal = [pscustomobject]@{ UserId = "$env:USERDOMAIN\$env:USERNAME"; RunLevel = 'Limited' }
        $validSettings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew' }
        $validTask = [pscustomobject]@{ Actions = @($validAction); Triggers = @($validTrigger); Principal = $validPrincipal; Settings = $validSettings }
        if (-not (Test-OwnedScheduledTask -Task $validTask -StartScript $testStartScript)) { throw 'Exact scheduled-task ownership test failed.' }
        $shortPrincipal = [pscustomobject]@{ UserId = $env:USERNAME; RunLevel = 'Limited' }
        $normalizedTask = [pscustomobject]@{ Actions = @($validAction); Triggers = @($validTrigger); Principal = $shortPrincipal; Settings = $validSettings }
        if (-not (Test-OwnedScheduledTask -Task $normalizedTask -StartScript $testStartScript)) { throw 'Scheduled-task identity normalization failed.' }
        $unrelatedAction = [pscustomobject]@{ Execute = $testPowerShell; Arguments = '-Command Write-Output unrelated'; WorkingDirectory = $repositoryRoot }
        $twoActionTask = [pscustomobject]@{ Actions = @($validAction, $unrelatedAction); Triggers = @($validTrigger); Principal = $validPrincipal; Settings = $validSettings }
        if (Test-OwnedScheduledTask -Task $twoActionTask -StartScript $testStartScript) { throw 'A scheduled task with an extra action must not be treated as owned.' }
        $missingDaemon = Invoke-NodeDaemonControl -NodePath $node.Source -DaemonPath (Join-Path $repositoryRoot 'runtime\daemon.mjs') -Mode status
        if ($missingDaemon.ExitCode -eq 0) { throw 'Daemon control should return a nonzero status when install state is absent.' }

        function Write-TestPayload {
            param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Marker)
            New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime'), (Join-Path $Root 'scripts'), (Join-Path $Root 'node_modules\chrome-devtools-mcp\build\src\bin') | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $Root 'runtime\daemon.mjs'), "$Marker runtime")
            [System.IO.File]::WriteAllText((Join-Path $Root 'scripts\common.ps1'), "$Marker scripts")
            [System.IO.File]::WriteAllText((Join-Path $Root 'package.json'), "$Marker package")
            [System.IO.File]::WriteAllText((Join-Path $Root 'npm-shrinkwrap.json'), "$Marker shrinkwrap")
            [System.IO.File]::WriteAllText((Join-Path $Root 'LICENSE'), "$Marker license")
            [System.IO.File]::WriteAllText((Join-Path $Root 'THIRD_PARTY_NOTICES.md'), "$Marker notices")
            [System.IO.File]::WriteAllText((Join-Path $Root 'node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js'), "$Marker dependencies")
        }
        function Get-TestPayloadHashManifest {
            param([Parameter(Mandatory)][string]$Root)
            $entries = [System.Collections.Generic.List[string]]::new()
            $getFileSha256 = {
                param([Parameter(Mandatory)][string]$Path)
                $sha = [System.Security.Cryptography.SHA256]::Create()
                try {
                    return ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($Path)))).Replace('-', '')
                } finally { $sha.Dispose() }
            }
            foreach ($itemName in $script:PayloadItemNames) {
                $itemPath = Join-Path $Root $itemName
                if (-not (Test-Path -LiteralPath $itemPath)) { throw "Test payload item is missing: $itemName" }
                foreach ($file in @(Get-ChildItem -LiteralPath $itemPath -File -Recurse -Force -ErrorAction Stop)) {
                    $relative = $file.FullName.Substring($Root.Length).TrimStart('\\')
                    $entries.Add($relative + '=' + (& $getFileSha256 $file.FullName))
                }
                if (Test-Path -LiteralPath $itemPath -PathType Leaf) {
                    $entries.Add($itemName + '=' + (& $getFileSha256 $itemPath))
                }
            }
            return [string]::Join("`n", @($entries | Sort-Object))
        }

        $upgradeRoot = Join-Path $temp 'upgrade-install-root'
        $stagedPayload = New-UniqueTransactionDirectory -Parent $temp -Name 'upgrade-staged-payload' -Label 'Upgrade test staging directory'
        $payloadBackup = New-UniqueTransactionDirectory -Parent $temp -Name 'upgrade-payload-backup' -Label 'Upgrade test backup directory'
        $failedPayload = New-UniqueTransactionDirectory -Parent $temp -Name 'upgrade-failed-payload' -Label 'Upgrade test failed-payload directory'
        Write-TestPayload -Root $upgradeRoot -Marker 'old'
        Write-TestPayload -Root $stagedPayload -Marker 'new'
        $oldPayloadHashManifest = Get-TestPayloadHashManifest -Root $upgradeRoot
        $oldMoved = [System.Collections.Generic.List[string]]::new()
        $newMoved = [System.Collections.Generic.List[string]]::new()
        Move-PayloadItems -SourceRoot $upgradeRoot -DestinationRoot $payloadBackup -MovedItems $oldMoved -Label 'Upgrade test backup'
        Move-PayloadItems -SourceRoot $stagedPayload -DestinationRoot $upgradeRoot -MovedItems $newMoved -Label 'Upgrade test staged install'
        if ($oldMoved.Count -ne $script:PayloadItemNames.Count -or $newMoved.Count -ne $script:PayloadItemNames.Count) {
            throw 'Upgrade test did not move every payload item.'
        }
        [Environment]::SetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP', '1', 'Process')
        $injectedFailureObserved = $false
        try { Invoke-TestOnlyFailureInjection }
        catch {
            if ($_.Exception.Message -eq 'Test-only failure injection after payload swap.') { $injectedFailureObserved = $true } else { throw }
        }
        if (-not $injectedFailureObserved) { throw 'Test-only payload failure injection did not run.' }

        New-Item -ItemType Directory -Path (Join-Path $failedPayload 'installed') | Out-Null
        foreach ($itemName in @($newMoved)) {
            Move-PayloadItem -Source (Join-Path $upgradeRoot $itemName) -Destination (Join-Path $failedPayload "installed\$itemName") -Label "Upgrade test quarantine $itemName"
        }
        foreach ($itemName in @($oldMoved)) {
            Move-PayloadItem -Source (Join-Path $payloadBackup $itemName) -Destination (Join-Path $upgradeRoot $itemName) -Label "Upgrade test restore $itemName"
        }
        $restoredPayloadHashManifest = Get-TestPayloadHashManifest -Root $upgradeRoot
        if ($restoredPayloadHashManifest -cne $oldPayloadHashManifest) { throw 'Upgrade rollback did not restore the old payload hashes.' }
        if ((Get-Content -LiteralPath (Join-Path $upgradeRoot 'runtime\daemon.mjs') -Raw) -cne 'old runtime') { throw 'Upgrade rollback did not restore the old daemon payload.' }
        if (-not (Test-Path -LiteralPath (Join-Path $failedPayload 'installed\runtime\daemon.mjs') -PathType Leaf)) { throw 'Failed new payload was not quarantined for diagnosis.' }
        $oldTaskWasRunning = $true
        $oldTaskWouldRestart = $oldTaskWasRunning -and (Test-Path -LiteralPath (Join-Path $upgradeRoot 'runtime\daemon.mjs') -PathType Leaf)
        if (-not $oldTaskWouldRestart) { throw 'The isolated rollback harness did not leave an operational old payload before old-task restart.' }

        Assert-InstallRemovalPathWithoutReparse -Path $upgradeRoot
    } finally {
        [Environment]::SetEnvironmentVariable('NODE_ENV', $savedNodeEnv, 'Process')
        [Environment]::SetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_LOAD_HELPERS', $savedHelperLoad, 'Process')
        [Environment]::SetEnvironmentVariable('DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP', $savedFailureInjection, 'Process')
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $resolvedTemp = [System.IO.Path]::GetFullPath($temp)
        if (-not $resolvedTemp.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedTemp -Leaf) -notlike 'bridge-tests-*') {
            throw 'Temporary test cleanup target failed its path guard.'
        }
        if (Test-Path -LiteralPath $resolvedTemp) {
            Assert-NoReparsePointOnPathOrAncestor -Path $resolvedTemp -Label 'Temporary test cleanup target'
            $testReparsePoints = @(Get-ChildItem -LiteralPath $resolvedTemp -Force -Recurse -ErrorAction Stop | Where-Object {
                ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            })
            if ($testReparsePoints.Count -gt 0) { throw 'Temporary test cleanup target contains a reparse point.' }
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }

    & $node.Source tests/proxy-args.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Gateway argument test failed.' }
    & npm.cmd pack --dry-run --json *> $null
    if ($LASTEXITCODE -ne 0) { throw 'npm pack dry run failed.' }
    & $node.Source tests/gateway-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Gateway smoke test failed.' }
    Write-Host 'All static, syntax, package, and helper tests passed.'
} finally {
    Pop-Location
}
