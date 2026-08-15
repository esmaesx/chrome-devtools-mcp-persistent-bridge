[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installRoot = Split-Path $PSScriptRoot -Parent
$statePath = Join-Path $installRoot 'install-state.json'
$daemonPath = Join-Path $installRoot 'runtime\daemon.mjs'
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$nodePath = [string]$state.node_path
$networkBridgeProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($installRoot) -and $_.CommandLine -match '--http|--port|--listen'
})

[pscustomobject]@{
    InstallRoot = $installRoot
    NetworkBridgeProcessCount = $networkBridgeProcesses.Count
    LocalTransport = 'Authenticated local named-pipe daemon plus per-task stdio gateways'
}

if ((Test-Path -LiteralPath $nodePath -PathType Leaf) -and (Test-Path -LiteralPath $daemonPath -PathType Leaf)) {
    & $nodePath $daemonPath --status
    exit $LASTEXITCODE
} else {
    Write-Warning 'The persistent daemon runtime is not installed. Run scripts\install.ps1.'
    exit 1
}
