[CmdletBinding()]
param(
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$manualInstructions = @(
    'Finish or close all client sessions that use this bridge.',
    'Wait for the lease to become free.',
    'Run the preflight again. Then run the installer again.'
)

try {
    Assert-Windows
    if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-DefaultInstallRoot }
    $InstallRoot = Assert-SafeLiteralPath -Path $InstallRoot -Label 'InstallRoot'
    $nodePath = Get-NodeExecutable
    $probePath = Join-Path $PSScriptRoot 'lease-preflight.mjs'
    if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) { throw 'The read-only lease probe is missing.' }
    $result = Get-BridgeInstallPreflight -InstallRoot $InstallRoot -NodePath $nodePath -ProbePath $probePath
} catch {
    $result = [pscustomobject][ordered]@{
        schema_version = 1
        ok = $false
        status = 'blocked'
        cause = 'lease_held_unknown'
        lease = [pscustomobject]@{ state = 'held_unknown' }
        gateway_state = 'unknown'
        instructions = $manualInstructions
    }
}

$result | ConvertTo-Json -Depth 6 -Compress
if (-not [bool]$result.ok) { exit 3 }
