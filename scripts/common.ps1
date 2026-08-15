[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:ConfigBegin = '# BEGIN dev-newb chrome-devtools-mcp-persistent-bridge'
$script:ConfigEnd = '# END dev-newb chrome-devtools-mcp-persistent-bridge'
$script:AgentsBegin = '<!-- BEGIN dev-newb chrome-devtools-mcp-persistent-bridge -->'
$script:AgentsEnd = '<!-- END dev-newb chrome-devtools-mcp-persistent-bridge -->'
$script:DefaultTaskName = 'DevNewb Chrome DevTools MCP Persistent Bridge'

function Get-DefaultCodexHome {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        return [System.IO.Path]::GetFullPath($env:CODEX_HOME)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex'))
}

function Get-DefaultInstallRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'dev-newb\chrome-devtools-mcp-persistent-bridge'))
}

function Assert-Windows {
    if ($env:OS -ne 'Windows_NT') { throw 'This package supports Windows only.' }
}

function Assert-SafeLiteralPath {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.Contains("'")) { throw "$Label cannot contain a single quote because it is written as a TOML literal string." }
    if ([string]::Equals($fullPath, [System.IO.Path]::GetPathRoot($fullPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label cannot be a drive root."
    }
    return $fullPath
}

function Get-NodeExecutable {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw 'Node.js is not installed or node.exe is not on PATH.' }
    $nodePath = [System.IO.Path]::GetFullPath($command.Source)
    $versionText = (& $nodePath --version).TrimStart('v')
    $version = [version]$versionText
    if ($version.Major -ne 24) { throw "Node.js 24.x is required for this tested release. Found $versionText." }
    return $nodePath
}

function Resolve-OfficialChromePath {
    param([string]$ChromePath)
    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ChromePath)) { $candidates.Add($ChromePath) }
    foreach ($process in @(Get-Process chrome -ErrorAction SilentlyContinue)) {
        try { if ($process.Path) { $candidates.Add($process.Path) } } catch { }
    }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )) {
        if ($candidate) { $candidates.Add($candidate) }
    }

    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        try {
            $fullPath = [System.IO.Path]::GetFullPath($candidate)
            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
            $signature = Get-AuthenticodeSignature -LiteralPath $fullPath
            $versionInfo = (Get-Item -LiteralPath $fullPath).VersionInfo
            if ($signature.Status -eq 'Valid' -and
                [string]$signature.SignerCertificate.Subject -match '(?:CN|O)=Google LLC' -and
                $versionInfo.CompanyName -eq 'Google LLC' -and
                $versionInfo.ProductName -eq 'Google Chrome') {
                return $fullPath
            }
        } catch { }
    }
    throw 'A valid Google-signed Google Chrome executable was not found. Use -ChromePath with an official Chrome path.'
}

function Remove-OwnedBlock {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Begin,
        [Parameter(Mandatory)][string]$End
    )
    $escapedBegin = [regex]::Escape($Begin)
    $escapedEnd = [regex]::Escape($End)
    $matches = [regex]::Matches($Text, "(?ms)^$escapedBegin\r?\n.*?^$escapedEnd\r?\n?")
    if ($matches.Count -gt 1) { throw "More than one owned block starts with '$Begin'." }
    return [regex]::Replace($Text, "(?ms)^$escapedBegin\r?\n.*?^$escapedEnd\r?\n?", '')
}

function Get-OwnedBlockText {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Begin,
        [Parameter(Mandatory)][string]$End
    )
    $escapedBegin = [regex]::Escape($Begin)
    $escapedEnd = [regex]::Escape($End)
    $matches = [regex]::Matches($Text, "(?ms)^$escapedBegin\r?\n.*?^$escapedEnd(?=\r?$)")
    if ($matches.Count -ne 1) { throw "Expected exactly one owned block starting with '$Begin'. Found $($matches.Count)." }
    return $matches[0].Value
}

function Get-TextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Remove-TomlMcpServerSection {
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][string]$ServerName)
    $lines = [regex]::Split($Text, '(?<=\n)')
    $kept = [System.Collections.Generic.List[string]]::new()
    $captured = [System.Collections.Generic.List[string]]::new()
    $inTarget = $false
    $found = $false
    $headerPattern = '^\s*\[([^\]]+)\]\s*(?:#.*)?\r?\n?$'
    $exact = "mcp_servers.$ServerName"
    foreach ($line in $lines) {
        $header = [regex]::Match($line, $headerPattern)
        if ($header.Success) {
            $name = $header.Groups[1].Value
            if ($name -eq $exact -or $name.StartsWith("$exact.", [StringComparison]::Ordinal)) {
                $inTarget = $true
                $found = $true
            } elseif ($inTarget) {
                $inTarget = $false
            }
        }
        if ($inTarget) { $captured.Add($line) } else { $kept.Add($line) }
    }
    return [pscustomobject]@{
        Found = $found
        Text = [string]::Concat($kept)
        Captured = [string]::Concat($captured)
    }
}

function Add-OwnedBlock {
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][string]$Block)
    $base = $Text.TrimEnd("`r", "`n")
    if ($base.Length -eq 0) { return "$Block`r`n" }
    return "$base`r`n`r`n$Block`r`n"
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [ref]$Committed
    )
    if ($null -ne $Committed) { $Committed.Value = $false }
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $fullPath))
    $temporaryPath = Join-Path $fullParent ('.' + (Split-Path -Leaf $fullPath) + '.dev-newb-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $replacementBackupPath = $temporaryPath + '.replaced'
    if (-not ([System.IO.Path]::GetFullPath($temporaryPath)).StartsWith($fullParent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The verified-write temporary path escaped its destination directory.'
    }
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Text, [System.Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $fullPath, $replacementBackupPath, $true)
        } else {
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
        if ($null -ne $Committed) { $Committed.Value = $true }
        $verified = [System.IO.File]::ReadAllText($fullPath, [System.Text.UTF8Encoding]::new($false))
        if ($verified -cne $Text) { throw "Verified UTF-8 write did not match its requested content: $fullPath" }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
        if (Test-Path -LiteralPath $replacementBackupPath -PathType Leaf) { Remove-Item -LiteralPath $replacementBackupPath -Force }
    }
}

function Set-OwnerOnlyDirectoryAcl {
    param([Parameter(Mandatory)][string]$Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $currentAcl = Get-Acl -LiteralPath $Path
    $expectedSids = @($currentSid.Value, $systemSid.Value)
    $currentRules = @($currentAcl.Access)
    $alreadyProtected = $currentAcl.AreAccessRulesProtected -and $currentRules.Count -eq 2
    foreach ($existingRule in $currentRules) {
        try { $existingSid = $existingRule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $alreadyProtected = $false; continue }
        if ($existingRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            $existingRule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
            $existingRule.IsInherited -or
            $expectedSids -notcontains $existingSid) { $alreadyProtected = $false }
    }
    if ($alreadyProtected) { return }
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $acl = $currentAcl
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existingRule) }
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, $rights, $inheritance, $propagation, $allow))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Get-AccountSidValue {
    param([Parameter(Mandatory)][string]$Identity)
    try {
        return ([System.Security.Principal.NTAccount]::new($Identity)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

function Test-SameAccountIdentity {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    $leftSid = Get-AccountSidValue -Identity $Left
    $rightSid = Get-AccountSidValue -Identity $Right
    if ($leftSid -and $rightSid) { return [string]::Equals($leftSid, $rightSid, [StringComparison]::OrdinalIgnoreCase) }
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-NodeDaemonControl {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$DaemonPath,
        [Parameter(Mandatory)][ValidateSet('status', 'stop')][string]$Mode
    )
    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = [System.IO.Path]::GetFullPath($NodePath)
    $processInfo.Arguments = '"' + ([System.IO.Path]::GetFullPath($DaemonPath)).Replace('"', '\"') + '" --' + $Mode
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    try {
        if (-not $process.Start()) { throw 'The daemon control process did not start.' }
        $standardOutput = $process.StandardOutput.ReadToEnd()
        $standardError = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $standardOutput.Trim()
            StandardError = $standardError.Trim()
        }
    } finally {
        $process.Dispose()
    }
}

function Test-OwnedScheduledTask {
    param([Parameter(Mandatory)]$Task, [Parameter(Mandatory)][string]$StartScript)
    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $expected = [System.IO.Path]::GetFullPath($StartScript)
    $expectedWorkingDirectory = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $expected -Parent) -Parent))
    $expectedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$expected`""
    $expectedUser = "$env:USERDOMAIN\$env:USERNAME"
    $actions = @($Task.Actions)
    $triggers = @($Task.Triggers)
    return $actions.Count -eq 1 -and
        [string]::Equals([System.IO.Path]::GetFullPath([string]$actions[0].Execute), $powerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$actions[0].Arguments, $expectedArguments, [StringComparison]::Ordinal) -and
        [string]::Equals([System.IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory), $expectedWorkingDirectory, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-SameAccountIdentity -Left ([string]$Task.Principal.UserId) -Right $expectedUser) -and
        [string]$Task.Principal.RunLevel -eq 'Limited' -and
        [string]$Task.Settings.MultipleInstances -eq 'IgnoreNew' -and
        $triggers.Count -eq 1 -and $triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'
}
