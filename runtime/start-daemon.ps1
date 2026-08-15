[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installRoot = Split-Path $PSScriptRoot -Parent
$statePath = Join-Path $installRoot 'install-state.json'
$daemonPath = Join-Path $installRoot 'runtime\daemon.mjs'
foreach ($requiredPath in @($statePath, $daemonPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required file is missing: $requiredPath" }
}
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$nodePath = [string]$state.node_path
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "The recorded Node.js executable is missing: $nodePath" }

& $nodePath $daemonPath
exit $LASTEXITCODE
