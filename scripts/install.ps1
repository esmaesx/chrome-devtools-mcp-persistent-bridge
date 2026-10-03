[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot,
    [string]$CodexHome,
    [string]$ChromePath,
    [string]$TaskName = 'DevNewb Chrome DevTools MCP Persistent Bridge',
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$McpServerName = 'chrome-devtools',
    [switch]$ReplaceExistingChromeMcp,
    [switch]$InstallAgentGuidance,
    [switch]$SkipScheduledTask,
    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if ($McpServerName -ne 'chrome-devtools') {
    $script:ConfigBegin = "# BEGIN sahar-tacit $McpServerName"
    $script:ConfigEnd = "# END sahar-tacit $McpServerName"
}

$script:PayloadItemNames = @('runtime', 'scripts', 'package.json', 'npm-shrinkwrap.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'node_modules')

function Assert-NoReparsePointOnPathOrAncestor {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $current = [System.IO.Path]::GetFullPath($Path)
    $volumeRoot = [System.IO.Path]::GetPathRoot($current)
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label contains a reparse point: $current"
            }
        }
        if ([string]::Equals($current, $volumeRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-TransactionChildPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $requiredPrefix = $fullParent + '\'
    if (-not $fullPath.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside its transaction directory."
    }
    Assert-NoReparsePointOnPathOrAncestor -Path $fullPath -Label $Label
    return $fullPath
}

function New-UniqueTransactionDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Label
    )
    $fullParent = [System.IO.Path]::GetFullPath($Parent)
    Assert-NoReparsePointOnPathOrAncestor -Path $fullParent -Label "$Label parent"
    New-Item -ItemType Directory -Force -Path $fullParent | Out-Null
    $candidate = Assert-TransactionChildPath -Parent $fullParent -Path (Join-Path $fullParent $Name) -Label $Label
    if (Test-Path -LiteralPath $candidate) { throw "$Label already exists: $candidate" }
    New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null
    Assert-NoReparsePointOnPathOrAncestor -Path $candidate -Label $Label
    return $candidate
}

function Move-PayloadItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$Label
    )
    $sourcePath = [System.IO.Path]::GetFullPath($Source)
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    if (-not (Test-Path -LiteralPath $sourcePath)) { throw "$Label source is missing: $sourcePath" }
    if (Test-Path -LiteralPath $destinationPath) { throw "$Label destination already exists: $destinationPath" }
    Assert-NoReparsePointOnPathOrAncestor -Path $sourcePath -Label "$Label source"
    $destinationParent = [System.IO.Directory]::GetParent($destinationPath)
    if ($null -eq $destinationParent) { throw "$Label destination has no parent." }
    Assert-NoReparsePointOnPathOrAncestor -Path $destinationParent.FullName -Label "$Label destination parent"
    if (-not [string]::Equals([System.IO.Path]::GetPathRoot($sourcePath), [System.IO.Path]::GetPathRoot($destinationPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must stay on one volume."
    }
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $destinationPath)) { throw "$Label move did not create its destination." }
}

function Move-PayloadItems {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$MovedItems,
        [Parameter(Mandatory)][string]$Label
    )
    $sourceRootPath = [System.IO.Path]::GetFullPath($SourceRoot)
    $destinationRootPath = [System.IO.Path]::GetFullPath($DestinationRoot)
    Assert-NoReparsePointOnPathOrAncestor -Path $sourceRootPath -Label "$Label source root"
    Assert-NoReparsePointOnPathOrAncestor -Path $destinationRootPath -Label "$Label destination root"
    foreach ($itemName in $script:PayloadItemNames) {
        $source = Assert-TransactionChildPath -Parent $sourceRootPath -Path (Join-Path $sourceRootPath $itemName) -Label "$Label source item"
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $destination = Assert-TransactionChildPath -Parent $destinationRootPath -Path (Join-Path $destinationRootPath $itemName) -Label "$Label destination item"
        Move-PayloadItem -Source $source -Destination $destination -Label "$Label $itemName"
        $MovedItems.Add($itemName)
    }
}

function Build-StagedCandidatePayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PackageRoot,
        [Parameter(Mandatory)][string]$StagingRoot
    )
    foreach ($itemName in @('runtime', 'scripts')) {
        $source = Join-Path $PackageRoot $itemName
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Required package directory is missing: $source" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $StagingRoot $itemName) -Recurse -Force -ErrorAction Stop
    }
    foreach ($itemName in @('package.json', 'npm-shrinkwrap.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
        $source = Join-Path $PackageRoot $itemName
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required package file is missing: $source" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $StagingRoot $itemName) -Force -ErrorAction Stop
    }
    Push-Location $StagingRoot
    try {
        & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    } finally { Pop-Location }
    foreach ($required in @(
        (Join-Path $StagingRoot 'node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js'),
        (Join-Path $StagingRoot 'runtime\start-daemon.ps1'),
        (Join-Path $StagingRoot 'runtime\daemon.mjs')
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required staged file is missing: $required" }
    }
}

function Invoke-TestOnlyFailureInjection {
    if ($env:NODE_ENV -eq 'test' -and $env:DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP -eq '1') {
        throw 'Test-only failure injection after payload swap.'
    }
}

if ($env:NODE_ENV -eq 'test' -and $env:DEV_NEWB_BRIDGE_TEST_LOAD_HELPERS -eq '1') { return }

Assert-Windows

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
if ([string]::IsNullOrWhiteSpace($CodexHome)) { $CodexHome = Get-DefaultCodexHome }
$InstallRoot = Assert-SafeLiteralPath -Path $InstallRoot -Label 'InstallRoot'
$CodexHome = Assert-SafeLiteralPath -Path $CodexHome -Label 'CodexHome'
$packageRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$nodePath = Get-NodeExecutable
$leaseProbePath = Join-Path $packageRoot 'scripts\lease-preflight.mjs'
$installPreflight = Get-BridgeInstallPreflight -InstallRoot $InstallRoot -NodePath $nodePath -ProbePath $leaseProbePath
if (-not [bool]$installPreflight.ok) {
    throw "Install preflight refused the in-place update ($([string]$installPreflight.cause)). Finish or close all client sessions that use this bridge. Wait for the lease to become free. Run scripts\preflight-install.ps1 again, then run scripts\install.ps1 again."
}
$officialChromePath = Resolve-OfficialChromePath -ChromePath $ChromePath
$configPath = Join-Path $CodexHome 'config.toml'
$agentsPath = Join-Path $CodexHome 'AGENTS.md'
$statePath = Join-Path $InstallRoot 'install-state.json'
$startScript = Join-Path $InstallRoot 'runtime\start-daemon.ps1'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$transactionId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$backupRoot = Join-Path $InstallRoot "backups\$transactionId"
$installParent = [System.IO.Directory]::GetParent($InstallRoot).FullName
$stagingRoot = $null
$payloadBackupRoot = Join-Path $backupRoot 'payload'
$failedPayloadRoot = Join-Path $backupRoot 'failed-payload'
$oldPayloadItems = [System.Collections.Generic.List[string]]::new()
$newPayloadItems = [System.Collections.Generic.List[string]]::new()
$payloadSwapStarted = $false
$payloadSwapComplete = $false

$oldConfigExists = Test-Path -LiteralPath $configPath -PathType Leaf
$oldAgentsExists = Test-Path -LiteralPath $agentsPath -PathType Leaf
$oldStateExists = Test-Path -LiteralPath $statePath -PathType Leaf
$oldConfig = if ($oldConfigExists) { Get-Content -LiteralPath $configPath -Raw } else { '' }
$oldAgents = if ($oldAgentsExists) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
$oldStateRaw = if ($oldStateExists) { Get-Content -LiteralPath $statePath -Raw } else { '' }
$oldState = if ($oldStateRaw) { $oldStateRaw | ConvertFrom-Json } else { $null }
$previousOriginalSections = if ($oldState) { [string]$oldState.original_mcp_sections } else { '' }
$installAgentGuidanceEffective = [bool]$InstallAgentGuidance -or ($oldState -and [bool]$oldState.installed_agent_guidance)
$daemonToken = if ($oldState -and -not [string]::IsNullOrWhiteSpace([string]$oldState.daemon_token)) {
    [string]$oldState.daemon_token
} else {
    $tokenBytes = [byte[]]::new(32)
    $tokenGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $tokenGenerator.GetBytes($tokenBytes) } finally { $tokenGenerator.Dispose() }
    [Convert]::ToBase64String($tokenBytes)
}
$taskCreatedByThisRun = $false
$configWritten = $false
$configWriteCommitted = $false
$agentsWritten = $false
$agentsWriteCommitted = $false
$stateWritten = $false
$newConfig = $null
$newAgents = $null
$existingTaskXml = $null
$existingTaskWasRunning = $false
$existingTaskStoppedByThisRun = $false
$existingDaemonRunning = $false

try {
    Assert-NoReparsePointOnPathOrAncestor -Path $InstallRoot -Label 'InstallRoot'
    Assert-NoReparsePointOnPathOrAncestor -Path $installParent -Label 'InstallRoot parent'
    New-Item -ItemType Directory -Force -Path $InstallRoot, $CodexHome, $backupRoot | Out-Null
    Assert-NoReparsePointOnPathOrAncestor -Path $backupRoot -Label 'Transaction backup'
    Set-OwnerOnlyDirectoryAcl -Path $InstallRoot
    if ($oldConfigExists) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupRoot 'config.toml') }
    if ($oldAgentsExists) { Copy-Item -LiteralPath $agentsPath -Destination (Join-Path $backupRoot 'AGENTS.md') }
    if ($oldStateExists) { Copy-Item -LiteralPath $statePath -Destination (Join-Path $backupRoot 'install-state.json') }

    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask -and -not (Test-OwnedScheduledTask -Task $existingTask -StartScript $startScript)) {
        throw "A different scheduled task already uses the name '$TaskName'."
    }
    if ($existingTask) {
        $existingTaskXml = Export-ScheduledTask -TaskName $TaskName
        Write-Utf8NoBom -Path (Join-Path $backupRoot 'scheduled-task.xml') -Text $existingTaskXml
        $existingTaskWasRunning = [string]$existingTask.State -eq 'Running'
        $existingDaemonScript = Join-Path $InstallRoot 'runtime\daemon.mjs'
        if ($oldState -and (Test-Path -LiteralPath $existingDaemonScript -PathType Leaf) -and (Test-Path -LiteralPath ([string]$oldState.node_path) -PathType Leaf)) {
            $existingNodePath = [System.IO.Path]::GetFullPath([string]$oldState.node_path)
            $existingStatusResult = Invoke-NodeDaemonControl -NodePath $existingNodePath -DaemonPath $existingDaemonScript -Mode status
            if ($existingStatusResult.ExitCode -eq 0) {
                $existingStatusText = $existingStatusResult.StandardOutput
                try { $existingStatus = $existingStatusText | ConvertFrom-Json } catch { throw 'The existing daemon returned malformed status. Installation did not replace the running task.' }
                $existingDaemonProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$existingStatus.pid)" -ErrorAction SilentlyContinue
                $existingDaemonOwned = $existingDaemonProcess -and
                    [string]::Equals([System.IO.Path]::GetFullPath([string]$existingStatus.install_root), $InstallRoot, [StringComparison]::OrdinalIgnoreCase) -and
                    [string]::Equals([string]$existingDaemonProcess.ExecutablePath, $existingNodePath, [StringComparison]::OrdinalIgnoreCase) -and
                    [string]$existingDaemonProcess.CommandLine -match [regex]::Escape($existingDaemonScript) -and
                    [string]$existingDaemonProcess.CommandLine -notmatch '(?:--status|--stop)'
                if (-not $existingDaemonOwned) { throw 'The existing daemon identity does not match this installation.' }
                $existingDaemonRunning = $true
            }
        }
        $exactExistingDaemons = @(Get-CimInstance Win32_Process | Where-Object {
            [string]$_.CommandLine -match [regex]::Escape($existingDaemonScript) -and
            [string]$_.CommandLine -notmatch '(?:--status|--stop)'
        })
        if ($existingDaemonRunning) {
            if ($exactExistingDaemons.Count -ne 1 -or [int]$exactExistingDaemons[0].ProcessId -ne [int]$existingStatus.pid) {
                throw 'The existing daemon process set does not match authenticated status. Installation did not stop or replace it.'
            }
        } elseif ($exactExistingDaemons.Count -gt 0) {
            throw 'An exact existing daemon process is running, but authenticated status is unavailable. Installation did not stop or replace it.'
        }
    }

    $configWithoutOwned = Remove-OwnedBlock -Text $oldConfig -Begin $script:ConfigBegin -End $script:ConfigEnd
    $originalSections = $previousOriginalSections
    $serversToCheck = if ($McpServerName -eq 'chrome-devtools') { @('chrome-devtools', 'chrome-debugging-recovery') } else { @($McpServerName) }
    foreach ($serverName in $serversToCheck) {
        $removal = Remove-TomlMcpServerSection -Text $configWithoutOwned -ServerName $serverName
        if ($removal.Found) {
            if (-not $ReplaceExistingChromeMcp) {
                throw "Codex config already defines '$serverName'. Re-run with -ReplaceExistingChromeMcp to back it up and replace it."
            }
            if ([string]::IsNullOrWhiteSpace($previousOriginalSections)) {
                $originalSections += $removal.Captured.TrimEnd() + "`r`n`r`n"
            } elseif ($previousOriginalSections.IndexOf($removal.Captured.Trim(), [StringComparison]::Ordinal) -lt 0) {
                throw "Codex config contains a new '$serverName' definition outside the managed block. It was preserved for manual review."
            }
            $configWithoutOwned = $removal.Text
        }
    }

    if ($PSCmdlet.ShouldProcess($InstallRoot, 'Install pinned bridge files and dependencies')) {
        $stagingRoot = New-UniqueTransactionDirectory -Parent $installParent -Name ('.chrome-devtools-mcp-stage-' + $transactionId) -Label 'Staging directory'
        Set-OwnerOnlyDirectoryAcl -Path $stagingRoot
        Build-StagedCandidatePayload -PackageRoot $packageRoot -StagingRoot $stagingRoot

        if ($existingTask) {
            if ($existingDaemonRunning) {
                $existingStopResult = Invoke-NodeDaemonControl -NodePath $existingNodePath -DaemonPath $existingDaemonScript -Mode stop
                if ($existingStopResult.ExitCode -ne 0) { throw 'The existing daemon did not confirm shutdown. Installation stopped before replacing files.' }
            }
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            $existingTaskStoppedByThisRun = $true
        }

        New-Item -ItemType Directory -Force -Path $payloadBackupRoot | Out-Null
        Assert-NoReparsePointOnPathOrAncestor -Path $payloadBackupRoot -Label 'Payload backup'
        $payloadSwapStarted = $true
        Move-PayloadItems -SourceRoot $InstallRoot -DestinationRoot $payloadBackupRoot -MovedItems $oldPayloadItems -Label 'Backup old payload'
        Move-PayloadItems -SourceRoot $stagingRoot -DestinationRoot $InstallRoot -MovedItems $newPayloadItems -Label 'Install staged payload'
        if ($newPayloadItems.Count -ne $script:PayloadItemNames.Count) { throw 'The staged payload is incomplete after the swap.' }
        $payloadSwapComplete = $true
        Invoke-TestOnlyFailureInjection

        $daemonScript = Join-Path $InstallRoot 'runtime\daemon.mjs'
        $proxyPath = Join-Path $InstallRoot 'runtime\stdio-proxy.mjs'
        $configBlock = @"
$($script:ConfigBegin)
[mcp_servers.$McpServerName]
command = '$nodePath'
args = ['$proxyPath', 'chrome-devtools']
startup_timeout_sec = 20.0
tool_timeout_sec = 130.0

[mcp_servers.$McpServerName.tools.click]
approval_mode = "approve"

[mcp_servers.$McpServerName.tools.evaluate_script]
approval_mode = "approve"

[mcp_servers.$McpServerName.tools.take_snapshot]
approval_mode = "approve"

$($script:ConfigEnd)
"@
        $newConfig = Add-OwnedBlock -Text $configWithoutOwned -Block $configBlock.TrimEnd()
        $currentConfigExists = Test-Path -LiteralPath $configPath -PathType Leaf
        $currentConfig = if ($currentConfigExists) { Get-Content -LiteralPath $configPath -Raw } else { '' }
        if ($currentConfigExists -ne $oldConfigExists -or $currentConfig -cne $oldConfig) { throw 'Codex config changed during installation. No managed config was written.' }
        $configWritten = $true
        Write-Utf8NoBom -Path $configPath -Text $newConfig -Committed ([ref]$configWriteCommitted)

        if ($installAgentGuidanceEffective) {
            $agentsWithoutOwned = Remove-OwnedBlock -Text $oldAgents -Begin $script:AgentsBegin -End $script:AgentsEnd
            $agentsBlock = @"
$($script:AgentsBegin)
# Chrome DevTools persistent bridge

- Use the configured persistent Chrome DevTools MCP server. Do not start another Chrome DevTools MCP server for this task.
- Treat its selected page as shared state. Before an inspection or action that depends on a page, call `list_pages`, then `select_page` for the intended page. Do not run Chrome DevTools call sequences in parallel.
- Make the first Chrome call a zero-argument `list_pages`. If the daemon dispatched it and it failed because Chrome shows its native permission dialog, call `chrome-devtools.allow_remote_debugging` one time. The gateway blocks this tool unless that exact condition occurred. Invalid arguments and a tool-level error result do not enable it. Then retry only `list_pages` one time.
- Never use recovery after a mutating call, and never automatically retry a mutating call after a timeout or closed transport. Its result is uncertain.
- The recovery tool can act only on one verified, signed, same-session English Chrome dialog. If it fails closed, ask the user to approve the dialog manually.
$($script:AgentsEnd)
"@
            $newAgents = Add-OwnedBlock -Text $agentsWithoutOwned -Block $agentsBlock.TrimEnd()
            $currentAgentsExists = Test-Path -LiteralPath $agentsPath -PathType Leaf
            $currentAgents = if ($currentAgentsExists) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
            if ($currentAgentsExists -ne $oldAgentsExists -or $currentAgents -cne $oldAgents) { throw 'AGENTS.md changed during installation. No agent guidance was written.' }
            Write-Output 'Installing the previewed managed AGENTS.md guidance because it was selected now or is owned by the prior installation.'
            Write-Output $agentsBlock
            $agentsWritten = $true
            Write-Utf8NoBom -Path $agentsPath -Text $newAgents -Committed ([ref]$agentsWriteCommitted)
        } else {
            Write-Output 'AGENTS.md was not changed. Re-run with -InstallAgentGuidance to add supplementary operating guidance.'
        }

        $state = [ordered]@{
            schema_version = 1
            package_version = '0.1.3'
            installed_at_utc = [DateTime]::UtcNow.ToString('o')
            install_root = $InstallRoot
            codex_home = $CodexHome
            config_path = $configPath
            agents_path = $agentsPath
            node_path = $nodePath
            expected_chrome_path = $officialChromePath
            daemon_token = $daemonToken
            config_begin = $script:ConfigBegin
            config_end = $script:ConfigEnd
            mcp_server_name = $McpServerName
            task_name = $TaskName
            original_mcp_sections = $originalSections
            latest_backup = $backupRoot
            installed_agent_guidance = $installAgentGuidanceEffective
            scheduled_task_installed = -not [bool]$SkipScheduledTask
            config_block_sha256 = Get-TextSha256 -Text $configBlock.TrimEnd("`r", "`n")
            agents_block_sha256 = $(if ($installAgentGuidanceEffective) { Get-TextSha256 -Text $agentsBlock.TrimEnd("`r", "`n") } else { '' })
            task_action_execute = $powerShellPath
            task_action_arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
            task_working_directory = $InstallRoot
            task_principal_user = "$env:USERDOMAIN\$env:USERNAME"
            task_principal_sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        }
        $stateWritten = $true
        Write-Utf8NoBom -Path $statePath -Text ($state | ConvertTo-Json -Depth 6)
        if ($SkipScheduledTask) {
            if ($existingTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
        } else {
            $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
            $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $InstallRoot
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
            $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
            $taskCreatedByThisRun = $true
            Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps one user-scoped Chrome DevTools MCP daemon ready for local Codex stdio proxies.' -Force | Out-Null
            if (-not $SkipStart) {
                Start-ScheduledTask -TaskName $TaskName
                $daemonReady = $false
                for ($attempt = 0; $attempt -lt 30; $attempt++) {
                    Start-Sleep -Milliseconds 500
                    $daemonProbe = Invoke-NodeDaemonControl -NodePath $nodePath -DaemonPath $daemonScript -Mode status
                    if ($daemonProbe.ExitCode -eq 0) { $daemonReady = $true; break }
                }
                if (-not $daemonReady) { throw 'The persistent Chrome daemon did not become ready after installation.' }
            }
        }
    }

    if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
        Assert-NoReparsePointOnPathOrAncestor -Path $stagingRoot -Label 'Completed staging directory'
        if (@(Get-ChildItem -LiteralPath $stagingRoot -Force -ErrorAction Stop).Count -eq 0) {
            Remove-Item -LiteralPath $stagingRoot -Force -ErrorAction Stop
        } else {
            Write-Warning "The completed staging directory was not empty and was preserved: $stagingRoot"
        }
    }

    Write-Output "Installed at: $InstallRoot"
    Write-Output "Codex config: $configPath"
    Write-Output 'Open a new Codex task, or restart an existing task, to load the MCP configuration.'
} catch {
    $installFailure = $_
    $rollbackFailures = [System.Collections.Generic.List[string]]::new()
    $oldTaskRollback = @{ Restored = $false }
    $payloadRollback = @{ Complete = -not $payloadSwapStarted }
    $configRollback = @{ Safe = -not $configWritten }
    $agentsRollback = @{ Safe = -not $agentsWritten }
    $stateRollback = @{ Complete = -not $stateWritten }
    $invokeRollbackStep = {
        param([string]$Label, [scriptblock]$Action)
        try { & $Action }
        catch { $rollbackFailures.Add("${Label}: $($_.Exception.Message)") }
    }

    if ($taskCreatedByThisRun) {
        & $invokeRollbackStep 'Stop new scheduled task' { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
        & $invokeRollbackStep 'Stop new daemon' {
            $newDaemonScript = Join-Path $InstallRoot 'runtime\daemon.mjs'
            if ((Test-Path -LiteralPath $newDaemonScript -PathType Leaf) -and (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
                Assert-NoReparsePointOnPathOrAncestor -Path $newDaemonScript -Label 'New daemon during rollback'
                $rollbackStatus = Invoke-NodeDaemonControl -NodePath $nodePath -DaemonPath $newDaemonScript -Mode status
                if ($rollbackStatus.ExitCode -eq 0) {
                    $rollbackStop = Invoke-NodeDaemonControl -NodePath $nodePath -DaemonPath $newDaemonScript -Mode stop
                    if ($rollbackStop.ExitCode -ne 0) { throw 'The new daemon did not confirm shutdown.' }
                }
            }
        }
    }

    if ($payloadSwapStarted) {
        & $invokeRollbackStep 'Create failed payload quarantine' {
            New-Item -ItemType Directory -Force -Path (Join-Path $failedPayloadRoot 'installed') | Out-Null
            Assert-NoReparsePointOnPathOrAncestor -Path $failedPayloadRoot -Label 'Failed payload quarantine'
        }
        foreach ($itemName in @($newPayloadItems)) {
            & $invokeRollbackStep "Quarantine failed payload $itemName" {
                $source = Join-Path $InstallRoot $itemName
                if (Test-Path -LiteralPath $source) {
                    Move-PayloadItem -Source $source -Destination (Join-Path $failedPayloadRoot "installed\$itemName") -Label "Quarantine failed payload $itemName"
                }
            }
        }
        if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
            & $invokeRollbackStep 'Quarantine incomplete staged payload' {
                Move-PayloadItem -Source $stagingRoot -Destination (Join-Path $failedPayloadRoot 'staged') -Label 'Quarantine incomplete staged payload'
            }
        }
        foreach ($itemName in @($oldPayloadItems)) {
            & $invokeRollbackStep "Restore old payload $itemName" {
                $source = Join-Path $payloadBackupRoot $itemName
                if (Test-Path -LiteralPath $source) {
                    Move-PayloadItem -Source $source -Destination (Join-Path $InstallRoot $itemName) -Label "Restore old payload $itemName"
                }
            }
        }
        & $invokeRollbackStep 'Verify restored old payload' {
            foreach ($itemName in @($oldPayloadItems)) {
                if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $itemName)) -or (Test-Path -LiteralPath (Join-Path $payloadBackupRoot $itemName))) {
                    throw "Old payload item was not fully restored: $itemName"
                }
            }
            if ($existingTaskXml) {
                foreach ($requiredItem in $script:PayloadItemNames) {
                    if ($oldPayloadItems -notcontains $requiredItem) { throw "The prior scheduled task payload was incomplete before upgrade: $requiredItem" }
                }
                foreach ($requiredRuntimeFile in @('runtime\start-daemon.ps1', 'runtime\daemon.mjs')) {
                    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $requiredRuntimeFile) -PathType Leaf)) {
                        throw "The restored scheduled task runtime is missing: $requiredRuntimeFile"
                    }
                }
            }
            $payloadRollback.Complete = $true
        }
    } elseif ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
        Write-Warning "The staged candidate was preserved for diagnosis: $stagingRoot"
    }

    if ($configWritten) {
        & $invokeRollbackStep 'Restore Codex config' {
            $configBackup = Join-Path $backupRoot 'config.toml'
            $currentConfigExists = Test-Path -LiteralPath $configPath -PathType Leaf
            $currentConfig = if ($currentConfigExists) { Get-Content -LiteralPath $configPath -Raw } else { '' }
            $changedAfterOurPoint = if ($configWriteCommitted) {
                (-not $currentConfigExists) -or $currentConfig -cne $newConfig
            } else {
                $currentConfigExists -ne $oldConfigExists -or $currentConfig -cne $oldConfig
            }
            if ($changedAfterOurPoint) {
                Write-Warning 'Codex config changed after the managed write. Rollback preserved the new content for manual review.'
                $configRollback.Safe = $true
            } elseif ($oldConfigExists -and (Test-Path -LiteralPath $configBackup -PathType Leaf)) {
                Write-Utf8NoBom -Path $configPath -Text $oldConfig
                if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or (Get-Content -LiteralPath $configPath -Raw) -cne $oldConfig) { throw 'The old Codex config was not verified after rollback.' }
                $configRollback.Safe = $true
            } elseif (-not $oldConfigExists -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
                Assert-NoReparsePointOnPathOrAncestor -Path $configPath -Label 'Codex config rollback target'
                Remove-Item -LiteralPath $configPath -Force -ErrorAction Stop
                if (Test-Path -LiteralPath $configPath) { throw 'The new Codex config remained after rollback.' }
                $configRollback.Safe = $true
            } elseif (-not $oldConfigExists) {
                $configRollback.Safe = $true
            } else {
                throw 'The Codex config rollback backup is missing.'
            }
        }
    }
    if ($agentsWritten) {
        & $invokeRollbackStep 'Restore AGENTS.md' {
            $agentsBackup = Join-Path $backupRoot 'AGENTS.md'
            $currentAgentsExists = Test-Path -LiteralPath $agentsPath -PathType Leaf
            $currentAgents = if ($currentAgentsExists) { Get-Content -LiteralPath $agentsPath -Raw } else { '' }
            $changedAfterOurPoint = if ($agentsWriteCommitted) {
                (-not $currentAgentsExists) -or $currentAgents -cne $newAgents
            } else {
                $currentAgentsExists -ne $oldAgentsExists -or $currentAgents -cne $oldAgents
            }
            if ($changedAfterOurPoint) {
                Write-Warning 'AGENTS.md changed after the managed write. Rollback preserved the new content for manual review.'
                $agentsRollback.Safe = $true
            } elseif ($oldAgentsExists -and (Test-Path -LiteralPath $agentsBackup -PathType Leaf)) {
                Write-Utf8NoBom -Path $agentsPath -Text $oldAgents
                if (-not (Test-Path -LiteralPath $agentsPath -PathType Leaf) -or (Get-Content -LiteralPath $agentsPath -Raw) -cne $oldAgents) { throw 'The old AGENTS.md was not verified after rollback.' }
                $agentsRollback.Safe = $true
            } elseif (-not $oldAgentsExists -and (Test-Path -LiteralPath $agentsPath -PathType Leaf)) {
                Assert-NoReparsePointOnPathOrAncestor -Path $agentsPath -Label 'AGENTS.md rollback target'
                Remove-Item -LiteralPath $agentsPath -Force -ErrorAction Stop
                if (Test-Path -LiteralPath $agentsPath) { throw 'The new AGENTS.md remained after rollback.' }
                $agentsRollback.Safe = $true
            } elseif (-not $oldAgentsExists) {
                $agentsRollback.Safe = $true
            } else {
                throw 'The AGENTS.md rollback backup is missing.'
            }
        }
    }
    if ($stateWritten) {
        & $invokeRollbackStep 'Restore install state' {
            $stateBackup = Join-Path $backupRoot 'install-state.json'
            if ($oldStateExists -and (Test-Path -LiteralPath $stateBackup -PathType Leaf)) {
                Write-Utf8NoBom -Path $statePath -Text $oldStateRaw
                if (-not (Test-Path -LiteralPath $statePath -PathType Leaf) -or (Get-Content -LiteralPath $statePath -Raw) -cne $oldStateRaw) { throw 'The old install state was not verified after rollback.' }
                $stateRollback.Complete = $true
            } elseif (-not $oldStateExists -and (Test-Path -LiteralPath $statePath -PathType Leaf)) {
                Assert-NoReparsePointOnPathOrAncestor -Path $statePath -Label 'Install state rollback target'
                Remove-Item -LiteralPath $statePath -Force -ErrorAction Stop
                if (Test-Path -LiteralPath $statePath) { throw 'The new install state remained after rollback.' }
                $stateRollback.Complete = $true
            } elseif (-not $oldStateExists) {
                $stateRollback.Complete = $true
            } else {
                throw 'The install-state rollback backup is missing.'
            }
        }
    }

    $taskWasModified = $taskCreatedByThisRun -or $existingTaskStoppedByThisRun
    if ($existingTaskXml -and $taskWasModified) {
        & $invokeRollbackStep 'Restore scheduled task XML' {
            Register-ScheduledTask -TaskName $TaskName -Xml $existingTaskXml -Force | Out-Null
            $oldTaskRollback.Restored = $true
        }
    } elseif ($taskCreatedByThisRun) {
        & $invokeRollbackStep 'Remove new scheduled task' {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    $rollbackSafeForTaskRestart = $payloadRollback.Complete -and $stateRollback.Complete -and $configRollback.Safe -and $agentsRollback.Safe
    if ($existingTaskWasRunning -and $oldTaskRollback.Restored -and $rollbackSafeForTaskRestart) {
        & $invokeRollbackStep 'Restart old scheduled task' { Start-ScheduledTask -TaskName $TaskName }
    } elseif ($existingTaskWasRunning -and $oldTaskRollback.Restored -and -not $rollbackSafeForTaskRestart) {
        $rollbackFailures.Add('Restart old scheduled task: blocked because payload, state, config, or AGENTS rollback was not safe; the task was left stopped')
    }

    if ($rollbackFailures.Count -gt 0) {
        Write-Warning "Rollback was incomplete: $($rollbackFailures -join '; ')"
    }
    throw $installFailure
}
