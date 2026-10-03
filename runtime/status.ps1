[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installRoot = Split-Path $PSScriptRoot -Parent
$statePath = Join-Path $installRoot 'install-state.json'
$daemonPath = Join-Path $installRoot 'runtime\daemon.mjs'
$networkBridgeProcessCount = $null

function Write-BridgeStatus {
    param(
        [Parameter(Mandatory)][bool]$DaemonOk,
        [Parameter(Mandatory)][string]$DaemonStatus,
        [AllowNull()]$DaemonCause,
        [AllowNull()]$DaemonPid,
        [AllowNull()]$DaemonInstanceId,
        [Parameter(Mandatory)][bool]$BackendConnected,
        [AllowNull()]$BackendGeneration,
        [Parameter(Mandatory)]$LeaseStatus,
        [Parameter(Mandatory)][ValidateRange(0, 255)][int]$ExitCode
    )

    $result = [ordered]@{
        schema_version = 2
        install_root = $installRoot
        local_transport = 'Authenticated local named-pipe daemon plus per-gateway stdio transport'
        network_bridge_process_count = $networkBridgeProcessCount
        daemon = [ordered]@{
            ok = $DaemonOk
            status = $DaemonStatus
            cause = $DaemonCause
            pid = $DaemonPid
            daemon_instance_id = $DaemonInstanceId
            backend_connected = $BackendConnected
            backend_generation = $BackendGeneration
        }
        lease = $LeaseStatus
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
    exit $ExitCode
}

function Write-SetupFailure {
    param(
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$Cause
    )

    Write-BridgeStatus `
        -DaemonOk $false `
        -DaemonStatus $Status `
        -DaemonCause $Cause `
        -DaemonPid $null `
        -DaemonInstanceId $null `
        -BackendConnected $false `
        -BackendGeneration $null `
        -LeaseStatus ([ordered]@{ state = 'held_unknown' }) `
        -ExitCode 4
}

try {
    try {
        $networkBridgeProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($installRoot) -and $_.CommandLine -match '--http|--port|--listen'
        })
        $networkBridgeProcessCount = $networkBridgeProcesses.Count
    } catch {
        $networkBridgeProcessCount = $null
    }

    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        Write-SetupFailure -Status 'not_installed' -Cause 'install_state_missing'
    }

    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-SetupFailure -Status 'invalid' -Cause 'install_state_invalid'
    }

    $stateIsObject = $null -ne $state -and $state -is [System.Management.Automation.PSCustomObject]
    $nodePathIsString = $stateIsObject -and $state.node_path -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$state.node_path)
    $tokenIsValid = $stateIsObject -and $state.daemon_token -is [string] -and ([string]$state.daemon_token).Length -ge 32
    $rootIsString = $stateIsObject -and $state.install_root -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$state.install_root)
    if (-not $nodePathIsString -or -not $tokenIsValid -or -not $rootIsString) {
        Write-SetupFailure -Status 'invalid' -Cause 'install_state_invalid'
    }

    try {
        if (-not [System.IO.Path]::IsPathRooted([string]$state.node_path)) { throw 'invalid' }
        $nodePath = [System.IO.Path]::GetFullPath([string]$state.node_path)
        $stateInstallRoot = [System.IO.Path]::GetFullPath([string]$state.install_root)
    } catch {
        Write-SetupFailure -Status 'invalid' -Cause 'install_state_invalid'
    }
    if (-not [string]::Equals($stateInstallRoot, $installRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Write-SetupFailure -Status 'invalid' -Cause 'install_state_invalid'
    }
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        Write-SetupFailure -Status 'runtime_missing' -Cause 'node_runtime_missing'
    }
    if (-not (Test-Path -LiteralPath $daemonPath -PathType Leaf)) {
        Write-SetupFailure -Status 'runtime_missing' -Cause 'daemon_runtime_missing'
    }

    $leaseStatus = [ordered]@{ state = 'held_unknown' }
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $leaseOutput = @(& $nodePath $daemonPath --lease-status 2>&1)
        $leaseExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    if ($leaseExitCode -eq 0) {
        try {
            $leaseCandidate = (($leaseOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
            if ([string]$leaseCandidate.state -eq 'free') {
                $leaseStatus = [ordered]@{ state = 'free' }
            } elseif ([string]$leaseCandidate.state -eq 'held') {
                $leaseStatus = [ordered]@{
                    state = 'held'
                    pid = $leaseCandidate.pid
                    parent_pid = $leaseCandidate.parent_pid
                    gateway_instance_id = $leaseCandidate.gateway_instance_id
                    lease_instance_id = $leaseCandidate.lease_instance_id
                    acquired_at_utc = $leaseCandidate.acquired_at_utc
                    last_activity_at_utc = $leaseCandidate.last_activity_at_utc
                    in_flight = $leaseCandidate.in_flight
                    queue_depth = $leaseCandidate.queue_depth
                }
            }
        } catch {
            $leaseStatus = [ordered]@{ state = 'held_unknown' }
        }
    }

    $daemonStatus = $null
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $daemonOutput = @(& $nodePath $daemonPath --status 2>&1)
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    try {
        $daemonStatus = (($daemonOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $daemonStatus = $null
    }

    $daemonRunning = $null -ne $daemonStatus -and [bool]$daemonStatus.ok -and [string]$daemonStatus.status -eq 'running'
    if ($daemonRunning) {
        Write-BridgeStatus `
            -DaemonOk $true `
            -DaemonStatus 'running' `
            -DaemonCause $null `
            -DaemonPid $daemonStatus.pid `
            -DaemonInstanceId $daemonStatus.daemon_instance_id `
            -BackendConnected ([bool]$daemonStatus.backend_connected) `
            -BackendGeneration $daemonStatus.backend_generation `
            -LeaseStatus $leaseStatus `
            -ExitCode 0
    }

    $allowedFailureCauses = @('daemon_absent', 'daemon_timeout', 'daemon_unreachable', 'daemon_invalid_status')
    $daemonFailureCause = if ($daemonStatus -and $allowedFailureCauses -contains [string]$daemonStatus.cause) {
        [string]$daemonStatus.cause
    } else {
        'daemon_status_invalid'
    }
    $daemonFailureStatus = if ($daemonStatus -and @('absent', 'unresponsive', 'unavailable', 'invalid') -contains [string]$daemonStatus.status) {
        [string]$daemonStatus.status
    } else {
        'invalid'
    }
    Write-BridgeStatus `
        -DaemonOk $false `
        -DaemonStatus $daemonFailureStatus `
        -DaemonCause $daemonFailureCause `
        -DaemonPid $null `
        -DaemonInstanceId $null `
        -BackendConnected $false `
        -BackendGeneration $null `
        -LeaseStatus $leaseStatus `
        -ExitCode 3
} catch {
    Write-SetupFailure -Status 'invalid' -Cause 'status_internal_error'
}
