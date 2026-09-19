param(
  [string]$RepositoryRoot = (Join-Path $PSScriptRoot '..'),
  [switch]$RequireNode24,
  [string]$NodeExe = 'node'
)
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
Import-Module Microsoft.PowerShell.Management -ErrorAction Stop
# Prove that neither profiles nor implicit module loading supply the hash command.
$PSModuleAutoLoadingPreference = 'None'
$temp = $null
try {
  $version = $PSVersionTable.PSVersion
  if ($version.Major -ne 5 -and $version.Major -lt 7) { throw 'Expected Windows PowerShell 5.1 or PowerShell 7+.' }
  if ($version.Major -eq 5 -and $version.Minor -lt 1) { throw 'PowerShell 5.1 is the minimum supported Windows PowerShell.' }
  Get-Command Get-FileHash -ErrorAction Stop | Out-Null
  $scripts = @(Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot 'scripts') -Filter '*.ps1' -File -Recurse)
  if ($scripts.Count -eq 0) { throw 'No release PowerShell scripts were discovered.' }
  foreach ($script in $scripts) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) { throw ('PowerShell parse error in ' + $script.Name + ': ' + ($parseErrors | Out-String)) }
  }
  $temp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'devspace preflight ' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  $file = [IO.Path]::Combine($temp, 'hash fixture with spaces.txt')
  [IO.File]::WriteAllBytes($file, [Text.Encoding]::UTF8.GetBytes('abc'))
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if ($actual -ine 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { throw 'Get-FileHash known-answer check failed.' }
  if ($RequireNode24) {
    $major = & $NodeExe -p 'process.versions.node.split(String.fromCharCode(46))[0]'
    if ($LASTEXITCODE -ne 0 -or $major -ne '24') { throw 'Node 24 is required for release acceptance.' }
  }
  @{ status = 'PASS'; scope = 'PowerShell parser and hash preflight only'; powerShell = $version.ToString(); scriptsParsed = $scripts.Count; node24Checked = [bool]$RequireNode24 } | ConvertTo-Json -Compress
} catch {
  @{ status = 'FAIL'; scope = 'PowerShell preflight'; reason = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($null -ne $temp -and [IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
}
