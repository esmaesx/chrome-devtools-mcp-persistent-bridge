[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot,
    [switch]$RemoveInstalledFiles
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Assert-InstallRemovalPathWithoutReparse {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $current = [System.IO.Path]::GetFullPath($Path)
    $volumeRoot = [System.IO.Path]::GetPathRoot($current)
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "The install root or one of its ancestors is a reparse point: $current. No recursive enumeration or deletion was attempted."
            }
        }
        if ([string]::Equals($current, $volumeRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-InstallRemovalTreeWithoutReparse {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    Assert-InstallRemovalPathWithoutReparse -Path $Path
    $reparsePoints = @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    })
    if ($reparsePoints.Count -gt 0) {
        throw "The install root contains $($reparsePoints.Count) reparse point(s). No recursive deletion was attempted."
    }
}

if ($env:NODE_ENV -eq 'test' -and $env:DEV_NEWB_BRIDGE_TEST_LOAD_HELPERS -eq '1') { return }

Assert-Windows

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
$InstallRoot = Assert-SafeLiteralPath -Path $InstallRoot -Label 'InstallRoot'
if ($RemoveInstalledFiles) { Assert-InstallRemovalPathWithoutReparse -Path $InstallRoot }
$statePath = Join-Path $InstallRoot 'install-state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw "Install state is missing: $statePath. No changes were made."
}
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.config_begin -and $state.config_end) {
    $script:ConfigBegin = [string]$state.config_begin
    $script:ConfigEnd = [string]$state.config_end
}
if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$state.install_root), $InstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install state does not own the requested install root.'
}

$configPath = [System.IO.Path]::GetFullPath([string]$state.config_path)
$agentsPath = [System.IO.Path]::GetFullPath([string]$state.agents_path)
$taskName = [string]$state.task_name
$startScript = Join-Path $InstallRoot 'runtime\start-daemon.ps1'

if ($RemoveInstalledFiles) {
    $defaultRoot = Get-DefaultInstallRoot
    if (-not [string]::Equals($InstallRoot, $defaultRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "For safety, -RemoveInstalledFiles is allowed only for the exact default install root '$defaultRoot'. No changes were made. Remove a custom install root manually after review."
    }
    Assert-InstallRemovalTreeWithoutReparse -Path $InstallRoot
}

$newConfig = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $newConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    $ownedConfigBlock = Get-OwnedBlockText -Text $newConfig -Begin $script:ConfigBegin -End $script:ConfigEnd
    if ((Get-TextSha256 -Text $ownedConfigBlock) -ne [string]$state.config_block_sha256) {
        throw 'The managed Codex config block was edited after installation. It was preserved for manual review.'
    }
    $newConfig = Remove-OwnedBlock -Text $newConfig -Begin $script:ConfigBegin -End $script:ConfigEnd
    $restored = [string]$state.original_mcp_sections
    if (-not [string]::IsNullOrWhiteSpace($restored)) {
        foreach ($serverName in @($(if ($state.mcp_server_name) { [string]$state.mcp_server_name } else { 'chrome-devtools' }), 'chrome-debugging-recovery')) {
            $check = Remove-TomlMcpServerSection -Text $newConfig -ServerName $serverName
            if ($check.Found) { throw "Codex config has a new '$serverName' definition. No uninstall changes were made." }
        }
        $newConfig = Add-OwnedBlock -Text $newConfig -Block $restored.Trim()
    }
} else { throw "Codex config is missing: $configPath. No uninstall changes were made." }
$newAgents = $null
if ([bool]$state.installed_agent_guidance -and (Test-Path -LiteralPath $agentsPath -PathType Leaf)) {
    $newAgents = Get-Content -LiteralPath $agentsPath -Raw -Encoding UTF8
    $ownedAgentsBlock = Get-OwnedBlockText -Text $newAgents -Begin $script:AgentsBegin -End $script:AgentsEnd
    if ((Get-TextSha256 -Text $ownedAgentsBlock) -ne [string]$state.agents_block_sha256) {
        throw 'The managed AGENTS.md block was edited after installation. It was preserved for manual review.'
    }
    $newAgents = Remove-OwnedBlock -Text $newAgents -Begin $script:AgentsBegin -End $script:AgentsEnd
} elseif ([bool]$state.installed_agent_guidance) {
    throw "The managed AGENTS.md file is missing: $agentsPath. No uninstall changes were made."
}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    $actions = @($task.Actions)
    $triggers = @($task.Triggers)
    $taskMatches = $actions.Count -eq 1 -and
        [string]::Equals([string]$actions[0].Execute, [string]$state.task_action_execute, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$actions[0].Arguments, [string]$state.task_action_arguments, [StringComparison]::Ordinal) -and
        [string]::Equals([string]$actions[0].WorkingDirectory, [string]$state.task_working_directory, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-SameAccountIdentity -Left ([string]$task.Principal.UserId) -Right ([string]$state.task_principal_user)) -and
        ((-not $state.task_principal_sid) -or [string]::Equals((Get-AccountSidValue -Identity ([string]$task.Principal.UserId)), [string]$state.task_principal_sid, [StringComparison]::OrdinalIgnoreCase)) -and
        [string]$task.Principal.RunLevel -eq 'Limited' -and
        [string]$task.Settings.MultipleInstances -eq 'IgnoreNew' -and
        $triggers.Count -eq 1 -and $triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'
    if (-not $taskMatches) { throw "Scheduled task '$taskName' changed after installation. It was preserved for manual review." }
}

$nodePath = [System.IO.Path]::GetFullPath([string]$state.node_path)
$daemonPath = Join-Path $InstallRoot 'runtime\daemon.mjs'
function Get-ExactDaemonProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
        [string]::Equals([string]$_.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase) -and
        [string]$_.CommandLine -match [regex]::Escape($daemonPath) -and
        [string]$_.CommandLine -notmatch '(?:--status|--stop)'
    })
}
function Get-ValidatedDaemonStatus {
    $candidates = @(Get-ExactDaemonProcesses)
    if ((Test-Path -LiteralPath $nodePath -PathType Leaf) -and (Test-Path -LiteralPath $daemonPath -PathType Leaf)) {
        $statusResult = Invoke-NodeDaemonControl -NodePath $nodePath -DaemonPath $daemonPath -Mode status
        if ($statusResult.ExitCode -eq 0) {
            try { $status = $statusResult.StandardOutput | ConvertFrom-Json } catch { throw 'The daemon returned malformed status. No uninstall changes were made.' }
            $candidateDaemon = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$status.pid)" -ErrorAction SilentlyContinue
            $daemonOwned = $candidateDaemon -and
                [string]::Equals([System.IO.Path]::GetFullPath([string]$status.install_root), $InstallRoot, [StringComparison]::OrdinalIgnoreCase) -and
                [string]::Equals([string]$candidateDaemon.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase) -and
                [string]$candidateDaemon.CommandLine -match [regex]::Escape($daemonPath) -and
                [string]$candidateDaemon.CommandLine -notmatch '(?:--status|--stop)'
            if (-not $daemonOwned) { throw 'The live daemon identity does not match this installation. No uninstall changes were made.' }
            return $status
        }
    }
    if ($candidates.Count -gt 0) {
        throw 'An exact daemon process is still running, but authenticated status is unavailable. The task, configuration, and installed files were preserved.'
    }
    return $null
}
$daemonStatus = Get-ValidatedDaemonStatus

if ($PSCmdlet.ShouldProcess($InstallRoot, 'Remove the owned bridge configuration and task')) {
    if ($task) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    $daemonStatus = Get-ValidatedDaemonStatus
    if ($daemonStatus) {
        $stopResult = Invoke-NodeDaemonControl -NodePath $nodePath -DaemonPath $daemonPath -Mode stop
        if ($stopResult.ExitCode -ne 0) { throw 'The daemon did not confirm shutdown. The task, configuration, and installed files were preserved.' }
        if ($null -ne (Get-ValidatedDaemonStatus)) { throw 'The daemon still responds after the stop request. The task, configuration, and installed files were preserved.' }
    }

    if ($task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    if ($null -ne $newConfig) {
        Write-Utf8NoBom -Path $configPath -Text $newConfig
    }

    if ($null -ne $newAgents) {
        Write-Utf8NoBom -Path $agentsPath -Text $newAgents
    }

    if ($RemoveInstalledFiles) {
        Assert-InstallRemovalTreeWithoutReparse -Path $InstallRoot
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
        Write-Output "Removed installed files: $InstallRoot"
    } else {
        Write-Output "Disabled the bridge and kept installed files: $InstallRoot"
        Write-Output 'Use -RemoveInstalledFiles to remove the default install directory.'
    }
}
