[CmdletBinding()]
param([string]$InstallRoot)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Windows
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
$InstallRoot = Assert-SafeLiteralPath -Path $InstallRoot -Label 'InstallRoot'
$statePath = Join-Path $InstallRoot 'install-state.json'
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [bool]$Pass, [string]$Detail)
    $script:checks.Add([pscustomobject]@{ Check = $Name; Pass = $Pass; Detail = $Detail })
}

function Test-OwnerOnlyAcl {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    try {
        $acl = Get-Acl -LiteralPath $Path
        if (-not $acl.AreAccessRulesProtected) { return $false }
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $allowedSids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [void]$allowedSids.Add($currentSid)
        [void]$allowedSids.Add('S-1-5-18')
        foreach ($rule in @($acl.Access)) {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
            if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or -not $allowedSids.Contains($sid)) {
                return $false
            }
        }
        return @($acl.Access).Count -ge 2
    } catch { return $false }
}

Add-Check 'install-state' (Test-Path -LiteralPath $statePath -PathType Leaf) $statePath
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $checks | Format-Table -AutoSize
    exit 1
}
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$nodePath = [string]$state.node_path
$chromePath = [string]$state.expected_chrome_path
$configPath = [string]$state.config_path
$agentsPath = [string]$state.agents_path
$taskName = [string]$state.task_name

Add-Check 'node' (Test-Path -LiteralPath $nodePath -PathType Leaf) $nodePath
Add-Check 'chrome' (Test-Path -LiteralPath $chromePath -PathType Leaf) $chromePath
Add-Check 'install-root-owner-only-acl' (Test-OwnerOnlyAcl -Path $InstallRoot) $InstallRoot
if (Test-Path -LiteralPath $chromePath -PathType Leaf) {
    $signature = Get-AuthenticodeSignature -LiteralPath $chromePath
    Add-Check 'chrome-signature' ($signature.Status -eq 'Valid' -and [string]$signature.SignerCertificate.Subject -match '(?:CN|O)=Google LLC') ([string]$signature.Status)
}

$configText = if (Test-Path -LiteralPath $configPath -PathType Leaf) { Get-Content -LiteralPath $configPath -Raw } else { '' }
$agentsText = if (Test-Path -LiteralPath $agentsPath -PathType Leaf) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
Add-Check 'codex-config-block' ($configText.Contains($script:ConfigBegin) -and $configText.Contains($script:ConfigEnd)) $configPath
$expectsAgentGuidance = [bool]$state.installed_agent_guidance
if ($expectsAgentGuidance) {
    Add-Check 'agents-rules-block' ($agentsText.Contains($script:AgentsBegin) -and $agentsText.Contains($script:AgentsEnd)) $agentsPath
} else {
    Add-Check 'agents-rules-block' $true 'not installed by request'
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$expectsTask = -not ($state.PSObject.Properties.Name -contains 'scheduled_task_installed') -or [bool]$state.scheduled_task_installed
$ownedTask = $false
if ($task) {
    $ownedTask = Test-OwnedScheduledTask -Task $task -StartScript (Join-Path $InstallRoot 'runtime\start-daemon.ps1')
    if ($ownedTask -and $state.task_principal_sid) {
        $ownedTask = [string]::Equals((Get-AccountSidValue -Identity ([string]$task.Principal.UserId)), [string]$state.task_principal_sid, [StringComparison]::OrdinalIgnoreCase)
    }
}
$taskPass = if ($expectsTask) { $ownedTask } else { $null -eq $task }
Add-Check 'scheduled-task-owned' $taskPass $(if ($task) { [string]$task.State } else { $(if ($expectsTask) { 'missing' } else { 'not installed by request' }) })

$daemonPath = Join-Path $InstallRoot 'runtime\daemon.mjs'
$daemonStatus = $null
$daemonStatusText = ''
$daemonStatusExit = -1
if ((Test-Path -LiteralPath $nodePath -PathType Leaf) -and (Test-Path -LiteralPath $daemonPath -PathType Leaf)) {
    $daemonStatusResult = Invoke-NodeDaemonControl -NodePath $nodePath -DaemonPath $daemonPath -Mode status
    $daemonStatusText = if ($daemonStatusResult.StandardOutput) { $daemonStatusResult.StandardOutput } else { $daemonStatusResult.StandardError }
    $daemonStatusExit = $daemonStatusResult.ExitCode
    if ($daemonStatusExit -eq 0) {
        try { $daemonStatus = $daemonStatusText | ConvertFrom-Json } catch { }
    }
}
$daemonRunning = $daemonStatusExit -eq 0 -and $null -ne $daemonStatus -and [string]$daemonStatus.status -eq 'running'
Add-Check 'daemon-status' $daemonRunning $daemonStatusText
$pipeValid = $daemonRunning -and [string]$daemonStatus.pipe -like '\\.\pipe\dev-newb-chrome-daemon-*'
Add-Check 'daemon-local-pipe' $pipeValid $(if ($daemonStatus) { [string]$daemonStatus.pipe } else { 'named pipe not reported' })
$daemonProcess = if ($daemonRunning) { Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$daemonStatus.pid)" -ErrorAction SilentlyContinue } else { $null }
$daemonIdentityMatches = $daemonProcess -and
    [string]::Equals([System.IO.Path]::GetFullPath([string]$daemonStatus.install_root), $InstallRoot, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$daemonProcess.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase) -and
    [string]$daemonProcess.CommandLine -match [regex]::Escape($daemonPath) -and
    [string]$daemonProcess.CommandLine -notmatch '(?:--status|--stop)'
Add-Check 'daemon-process-identity' $daemonIdentityMatches $(if ($daemonProcess) { "pid=$($daemonProcess.ProcessId)" } else { 'missing' })
Add-Check 'backend-connected' ($daemonRunning -and [bool]$daemonStatus.backend_connected) $(if ($daemonStatus) { "generation=$($daemonStatus.backend_generation)" } else { 'unavailable' })

$networkBridgeProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($InstallRoot) -and $_.CommandLine -match '--http|--port|--listen'
})
Add-Check 'no-network-listener-mode' ($networkBridgeProcesses.Count -eq 0) "matching_processes=$($networkBridgeProcesses.Count)"

$allProcesses = @(Get-CimInstance Win32_Process)
$legacyDirect = @($allProcesses | Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -and
    $_.CommandLine -notmatch [regex]::Escape($InstallRoot) -and
    (
        $_.CommandLine -match '(?i)(?:npx(?:-cli\.js)?.*chrome-devtools-mcp|npm-cache\\_npx.*chrome-devtools-mcp)' -or
        $_.CommandLine -match '(?i)[\\/]chrome-devtools-mcp(?:[\\/]|\.js)' -or
        $_.CommandLine -match '(?i)[\\/]chrome-devtools-bridge[\\/]'
    )
})
Add-Check 'no-legacy-direct-chrome-mcp' ($legacyDirect.Count -eq 0) "matching_processes=$($legacyDirect.Count); pids=$((@($legacyDirect.ProcessId) -join ','))"

$treePids = [System.Collections.Generic.HashSet[int]]::new()
if ($daemonRunning) { [void]$treePids.Add([int]$daemonStatus.pid) }
$installProcesses = @($allProcesses | Where-Object { $_.CommandLine -match [regex]::Escape($InstallRoot) })
foreach ($process in $installProcesses) { [void]$treePids.Add([int]$process.ProcessId) }
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($process in $allProcesses) {
        if ($treePids.Contains([int]$process.ParentProcessId) -and $treePids.Add([int]$process.ProcessId)) { $changed = $true }
    }
}
$tcpListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $treePids.Contains([int]$_.OwningProcess) })
$udpListeners = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $treePids.Contains([int]$_.OwningProcess) })
Add-Check 'no-process-tree-network-listeners' ($tcpListeners.Count -eq 0 -and $udpListeners.Count -eq 0) "tcp=$($tcpListeners.Count); udp=$($udpListeners.Count)"

$shrinkwrapPath = Join-Path $InstallRoot 'npm-shrinkwrap.json'
if (Test-Path -LiteralPath $shrinkwrapPath -PathType Leaf) {
    $shrinkwrapText = Get-Content -LiteralPath $shrinkwrapPath -Raw
    $versionPinsMatch = $shrinkwrapText -match '"chrome-devtools-mcp"\s*:\s*"1\.7\.0"' -and
        $shrinkwrapText -match '"@modelcontextprotocol/sdk"\s*:\s*"1\.29\.0"' -and
        $shrinkwrapText -match '"zod"\s*:\s*"4\.4\.3"'
    Add-Check 'exact-root-dependency-pins' $versionPinsMatch 'chrome-devtools-mcp=1.7.0; sdk=1.29.0; zod=4.4.3'
}

$expectedFiles = @(
    'package.json', 'npm-shrinkwrap.json',
    'runtime\stdio-proxy.mjs', 'runtime\allow-remote-debugging.ps1',
    'runtime\daemon.mjs', 'runtime\start-daemon.ps1', 'runtime\status.ps1'
)
foreach ($relativePath in $expectedFiles) {
    Add-Check "file:$relativePath" (Test-Path -LiteralPath (Join-Path $InstallRoot $relativePath) -PathType Leaf) $relativePath
}

$checks | Format-Table -AutoSize
$failed = @($checks | Where-Object { -not $_.Pass })
if ($failed.Count -gt 0) {
    Write-Error "$($failed.Count) doctor check(s) failed."
    exit 1
}
Write-Output 'All doctor checks passed.'
