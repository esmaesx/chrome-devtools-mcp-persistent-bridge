[CmdletBinding()]
param(
    [switch]$ProbeOnly,
    [ValidateRange(100, 5000)]
    [int]$PostActionWaitMilliseconds = 900
)

$ErrorActionPreference = 'Stop'
$expectedTitle = 'Allow remote debugging?'
$expectedMessagePart1 = 'An external app wants full control over this Chrome session to debug it. This includes access to your saved data, cookies and site data, and the ability to navigate to any URL.'
$expectedMessagePart2 = 'Only web developers should turn on this feature, and only use it with trusted apps.'
$installRoot = Split-Path $PSScriptRoot -Parent
$statePath = Join-Path $installRoot 'install-state.json'

function Rotate-AuditLog {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    if ((Get-Item -LiteralPath $Path).Length -lt 1MB) { return }
    for ($index = 4; $index -ge 1; $index--) {
        $source = "$Path.$index"
        $target = "$Path.$($index + 1)"
        if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $target -Force }
    }
    Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
}

function Protect-AuditDirectory {
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

function Write-Result {
    param([Parameter(Mandatory)][hashtable]$Value, [int]$ExitCode = 0)
    $auditDirectory = Join-Path $installRoot 'logs'
    $auditPath = Join-Path $auditDirectory 'recovery-audit.jsonl'
    try {
        New-Item -ItemType Directory -Force -Path $auditDirectory | Out-Null
        Rotate-AuditLog -Path $auditPath
        $auditRecord = [ordered]@{
            timestamp_utc = [DateTime]::UtcNow.ToString('o')
            status = $Value.status
            mutated = $Value.mutated
            process_id = $Value.process_id
            window_handle = $Value.window_handle
            detail = $Value.detail
        }
        Add-Content -LiteralPath $auditPath -Value ($auditRecord | ConvertTo-Json -Compress) -Encoding UTF8
    } catch {
        $Value.audit_error = 'The recovery audit record could not be written.'
    }
    $Value | ConvertTo-Json -Compress -Depth 8 | Write-Output
    exit $ExitCode
}

try {
    Protect-AuditDirectory -Path (Join-Path $installRoot 'logs')
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'The install state file is missing.' }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $expectedChromePath = [System.IO.Path]::GetFullPath([string]$state.expected_chrome_path)
    if (-not (Test-Path -LiteralPath $expectedChromePath -PathType Leaf)) { throw 'The installed Chrome executable is missing.' }
    $expectedChromePath = (Resolve-Path -LiteralPath $expectedChromePath).ProviderPath

    $signature = Get-AuthenticodeSignature -LiteralPath $expectedChromePath
    $signerSubject = [string]$signature.SignerCertificate.Subject
    if ($signature.Status -ne 'Valid' -or $signerSubject -notmatch '(?:CN|O)=Google LLC') {
        throw 'The configured Chrome executable does not have a valid Google signature.'
    }

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    if ($null -eq ('ChromeDebuggingRecovery.NativeWindow' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace ChromeDebuggingRecovery {
  public static class NativeWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    public static string GetTitle(IntPtr hWnd) { var text = new StringBuilder(512); GetWindowText(hWnd, text, text.Capacity); return text.ToString(); }
    public static string GetClass(IntPtr hWnd) { var text = new StringBuilder(256); GetClassName(hWnd, text, text.Capacity); return text.ToString(); }
    public static uint GetProcessId(IntPtr hWnd) { uint processId; GetWindowThreadProcessId(hWnd, out processId); return processId; }
    public static IntPtr[] FindVisibleWindowsWithExactTitle(string title) {
      var matches = new List<IntPtr>();
      EnumWindows((hWnd, lParam) => { if (IsWindowVisible(hWnd) && String.Equals(GetTitle(hWnd), title, StringComparison.Ordinal)) matches.Add(hWnd); return true; }, IntPtr.Zero);
      return matches.ToArray();
    }
  }
}
'@
    }

    $currentSessionId = (Get-Process -Id $PID).SessionId
    $pathCursor = Get-Item -LiteralPath $expectedChromePath
    while ($null -ne $pathCursor) {
        if (($pathCursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The configured Chrome path contains a reparse point and is not accepted.'
        }
        $pathCursor = $pathCursor.Parent
    }
    $candidates = @()
    foreach ($windowHandle in [ChromeDebuggingRecovery.NativeWindow]::FindVisibleWindowsWithExactTitle($expectedTitle)) {
        $candidateProcessId = [int][ChromeDebuggingRecovery.NativeWindow]::GetProcessId($windowHandle)
        $candidateProcess = Get-Process -Id $candidateProcessId -ErrorAction SilentlyContinue
        if ($null -eq $candidateProcess -or $candidateProcess.SessionId -ne $currentSessionId) { continue }
        try { $candidatePath = (Resolve-Path -LiteralPath $candidateProcess.Path).ProviderPath } catch { continue }
        if (-not [string]::Equals($candidatePath, $expectedChromePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ([ChromeDebuggingRecovery.NativeWindow]::GetClass($windowHandle) -ne 'Chrome_WidgetWin_1') { continue }
        $ownerHandle = [ChromeDebuggingRecovery.NativeWindow]::GetWindow($windowHandle, 4)
        if ($ownerHandle -eq [IntPtr]::Zero) { continue }
        if ([int][ChromeDebuggingRecovery.NativeWindow]::GetProcessId($ownerHandle) -ne $candidateProcessId) { continue }
        $versionInfo = (Get-Item -LiteralPath $candidatePath).VersionInfo
        if ($versionInfo.CompanyName -ne 'Google LLC' -or $versionInfo.ProductName -ne 'Google Chrome') { continue }
        $candidates += [pscustomobject]@{
            Handle = $windowHandle
            OwnerHandle = $ownerHandle
            ProcessId = $candidateProcessId
            ProcessStartTimeUtc = $candidateProcess.StartTime.ToUniversalTime().ToString('o')
        }
    }

    if ($candidates.Count -eq 0) {
        Write-Result @{ status = 'not_found'; mutated = $false; detail = 'No verified Chrome remote-debugging permission dialog is visible.' }
    }
    if ($candidates.Count -ne 1) {
        Write-Result @{ status = 'blocked_multiple_dialogs'; mutated = $false; candidate_count = $candidates.Count; detail = 'More than one verified dialog is visible. No action was taken.' } 2
    }

    $candidate = $candidates[0]
    $automationRoot = [Windows.Automation.AutomationElement]::FromHandle($candidate.Handle)
    if ($null -eq $automationRoot -or $automationRoot.Current.Name -ne $expectedTitle) {
        Write-Result @{ status = 'blocked_invalid_window'; mutated = $false; detail = 'The window does not have the expected UI Automation identity.' } 2
    }
    if ($automationRoot.Current.ControlType -ne [Windows.Automation.ControlType]::Window -or $automationRoot.Current.ClassName -ne 'Chrome_WidgetWin_1') {
        Write-Result @{ status = 'blocked_non_native_dialog'; mutated = $false; detail = 'The matching window is not the supported native Chrome window type.' } 2
    }
    $documentCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Document)
    $documentNodes = $automationRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $documentCondition)
    if ($documentNodes.Count -ne 0) {
        Write-Result @{ status = 'blocked_web_content'; mutated = $false; document_count = $documentNodes.Count; detail = 'The matching window contains web document content. No action was taken.' } 2
    }

    $buttonCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    $buttons = $automationRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    $allowButtons = @($buttons | Where-Object { $_.Current.Name -eq 'Allow' -and $_.Current.IsEnabled })
    $cancelButtons = @($buttons | Where-Object { $_.Current.Name -eq 'Cancel' })
    $settingsButtons = @($buttons | Where-Object { $_.Current.Name -eq 'Turn off in settings' })
    $textControlCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
    $textNodes = $automationRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $textControlCondition)
    $accessibleText = (($textNodes | ForEach-Object { [string]$_.Current.Name }) -join ' ') -replace '\s+', ' '
    $bodyMatches = $accessibleText.Contains($expectedMessagePart1) -and $accessibleText.Contains($expectedMessagePart2)
    if ($buttons.Count -ne 3 -or $allowButtons.Count -ne 1 -or $cancelButtons.Count -ne 1 -or $settingsButtons.Count -ne 1 -or -not $bodyMatches) {
        Write-Result @{ status = 'blocked_unexpected_dialog_shape'; mutated = $false; button_count = $buttons.Count; allow_button_count = $allowButtons.Count; cancel_button_count = $cancelButtons.Count; settings_button_count = $settingsButtons.Count; body_matches = $bodyMatches; detail = 'The dialog does not match the supported English Chrome title, warning text, and button set. No action was taken.' } 2
    }
    if ($ProbeOnly) {
        Write-Result @{ status = 'ready'; mutated = $false; process_id = $candidate.ProcessId; window_handle = $candidate.Handle.ToInt64(); detail = 'One verified Chrome permission dialog is ready.' }
    }

    $sameProcess = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
    $sameCandidateWindows = @([ChromeDebuggingRecovery.NativeWindow]::FindVisibleWindowsWithExactTitle($expectedTitle) | Where-Object { $_ -eq $candidate.Handle })
    $sameProcessPath = $null
    if ($sameProcess) { try { $sameProcessPath = (Resolve-Path -LiteralPath $sameProcess.Path).ProviderPath } catch { } }
    $freshRoot = if ([ChromeDebuggingRecovery.NativeWindow]::IsWindow($candidate.Handle)) { [Windows.Automation.AutomationElement]::FromHandle($candidate.Handle) } else { $null }
    $freshDocuments = if ($freshRoot) { $freshRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $documentCondition) } else { $null }
    $freshButtons = if ($freshRoot) { $freshRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition) } else { $null }
    $freshAllowButtons = @($freshButtons | Where-Object { $_.Current.Name -eq 'Allow' -and $_.Current.IsEnabled })
    $freshCancelButtons = @($freshButtons | Where-Object { $_.Current.Name -eq 'Cancel' })
    $freshSettingsButtons = @($freshButtons | Where-Object { $_.Current.Name -eq 'Turn off in settings' })
    $freshTextNodes = if ($freshRoot) { $freshRoot.FindAll([Windows.Automation.TreeScope]::Descendants, $textControlCondition) } else { $null }
    $freshAccessibleText = (($freshTextNodes | ForEach-Object { [string]$_.Current.Name }) -join ' ') -replace '\s+', ' '
    $preInvokeValid = $null -ne $sameProcess -and
        $sameProcess.SessionId -eq $currentSessionId -and
        $sameProcess.StartTime.ToUniversalTime().ToString('o') -eq $candidate.ProcessStartTimeUtc -and
        [string]::Equals($sameProcessPath, $expectedChromePath, [StringComparison]::OrdinalIgnoreCase) -and
        $sameCandidateWindows.Count -eq 1 -and
        [ChromeDebuggingRecovery.NativeWindow]::GetClass($candidate.Handle) -eq 'Chrome_WidgetWin_1' -and
        [ChromeDebuggingRecovery.NativeWindow]::GetWindow($candidate.Handle, 4) -eq $candidate.OwnerHandle -and
        $null -ne $freshRoot -and $freshRoot.Current.Name -eq $expectedTitle -and
        $freshRoot.Current.ControlType -eq [Windows.Automation.ControlType]::Window -and
        $freshRoot.Current.ClassName -eq 'Chrome_WidgetWin_1' -and
        $freshDocuments.Count -eq 0 -and $freshButtons.Count -eq 3 -and
        $freshAllowButtons.Count -eq 1 -and $freshCancelButtons.Count -eq 1 -and $freshSettingsButtons.Count -eq 1 -and
        $freshAccessibleText.Contains($expectedMessagePart1) -and $freshAccessibleText.Contains($expectedMessagePart2)
    if (-not $preInvokeValid) {
        Write-Result @{ status = 'blocked_dialog_changed'; mutated = $false; process_id = $candidate.ProcessId; window_handle = $candidate.Handle.ToInt64(); detail = 'The verified dialog identity changed before invocation. No action was taken.' } 2
    }

    $invokeError = $null
    try {
        $invokePattern = $freshAllowButtons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
        ([Windows.Automation.InvokePattern]$invokePattern).Invoke()
    } catch { $invokeError = $_.Exception.Message }

    Start-Sleep -Milliseconds $PostActionWaitMilliseconds
    $sameWindowStillPresent = [ChromeDebuggingRecovery.NativeWindow]::IsWindow($candidate.Handle) -and [ChromeDebuggingRecovery.NativeWindow]::GetTitle($candidate.Handle) -eq $expectedTitle
    $chromeStillRunning = $null -ne (Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue)
    if ($sameWindowStillPresent) {
        Write-Result @{ status = 'dialog_remained'; mutated = $true; process_id = $candidate.ProcessId; window_handle = $candidate.Handle.ToInt64(); chrome_still_running = $chromeStillRunning; invoke_error = $invokeError; detail = 'The action was attempted, but the same dialog remains. Do not repeat the input action.' } 3
    }
    $replacementDialogs = @([ChromeDebuggingRecovery.NativeWindow]::FindVisibleWindowsWithExactTitle($expectedTitle))
    if ($replacementDialogs.Count -gt 0) {
        Write-Result @{ status = 'dialog_changed_or_replaced'; mutated = $true; process_id = $candidate.ProcessId; window_handle = $candidate.Handle.ToInt64(); invoke_error = $invokeError; detail = 'The original dialog changed or was replaced. Do not invoke again.' } 4
    }
    if (-not $chromeStillRunning -or $null -ne $invokeError) {
        Write-Result @{ status = 'invoke_error_dialog_closed_indeterminate'; mutated = $true; process_id = $candidate.ProcessId; window_handle = $candidate.Handle.ToInt64(); chrome_still_running = $chromeStillRunning; invoke_error = $invokeError; detail = 'The verified dialog closed, but the approval result is indeterminate. Do not invoke again. One read-only list_pages call can test the end-to-end result.' } 4
    }
    Write-Result @{ status = 'invoked_dialog_closed'; mutated = $true; process_id = $candidate.ProcessId; window_handle = $candidate.Handle.ToInt64(); chrome_still_running = $chromeStillRunning; detail = 'The verified native dialog closed after one invocation. This does not prove approval succeeded. One read-only list_pages call can test the end-to-end result.' }
} catch {
    Write-Result @{ status = 'error'; mutated = $false; detail = $_.Exception.Message } 1
}
