param(
  [Parameter(Mandatory=$true)][ValidateSet('inspect','terminate','listener')][string]$Action,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$TargetPid,
  [string]$ExpectedStart = '', [string]$ExpectedExecutable = '',
  [ValidateRange(0,65535)][int]$Port = 0
)
$ErrorActionPreference = 'Stop'
# Never Stop-Process, taskkill, name matching or process-tree termination.
# Verification and termination operate on one retained kernel process handle.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DevSpaceRuntimeProcess {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder path, ref int length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$access = [uint32]0x101000
if ($Action -eq 'terminate') { $access = $access -bor 1 }
$handle = [DevSpaceRuntimeProcess]::OpenProcess($access, $false, $TargetPid)
if ($handle -eq [IntPtr]::Zero) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($errorCode -eq 87) { '{"kind":"absent"}' } else { '{"kind":"uncertain"}' }
  exit 0
}
try {
  [long]$created=0; [long]$exited=0; [long]$kernel=0; [long]$user=0; [uint32]$exitCode=0
  if (-not [DevSpaceRuntimeProcess]::GetProcessTimes($handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)) { throw 'GetProcessTimes failed' }
  $wait = [DevSpaceRuntimeProcess]::WaitForSingleObject($handle,0)
  if ($wait -eq 0) { '{"kind":"absent"}'; exit 0 }
  if ($wait -ne 258) { throw 'Process state unavailable' }
  $buffer = New-Object Text.StringBuilder 32768; $length=32768
  if (-not [DevSpaceRuntimeProcess]::QueryFullProcessImageName($handle,0,$buffer,[ref]$length)) { throw 'Executable unavailable' }
  $start = 'win:' + $created.ToString([Globalization.CultureInfo]::InvariantCulture)
  $executable = $buffer.ToString().ToLowerInvariant()
  if ($Action -eq 'inspect') {
    @{kind='observed';identity=@{pid=$TargetPid;processStartTime=$start;executable=$executable}} | ConvertTo-Json -Compress
  } elseif ($start -cne $ExpectedStart -or $executable -cne $ExpectedExecutable) {
    @{kind='mismatch';terminated=$false;ownsPort=$false} | ConvertTo-Json -Compress
  } elseif ($Action -eq 'terminate') {
    @{terminated=[DevSpaceRuntimeProcess]::TerminateProcess($handle,143)} | ConvertTo-Json -Compress
  } else {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    $owned = @($listeners | Where-Object { $_.OwningProcess -eq $TargetPid }).Count -gt 0
    $wait = [DevSpaceRuntimeProcess]::WaitForSingleObject($handle,0)
    @{ownsPort=($owned -and $wait -eq 258)} | ConvertTo-Json -Compress
  }
} catch {
  '{"kind":"uncertain","terminated":false,"ownsPort":false}'
} finally { [void][DevSpaceRuntimeProcess]::CloseHandle($handle) }
