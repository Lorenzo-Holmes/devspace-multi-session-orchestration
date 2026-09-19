param(
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$ReleasePath
)
$ErrorActionPreference = 'Stop'
$cardRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($cardRepo -ne 'D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace') { throw 'Isolated repository required.' }
$cardRelease = (Resolve-Path -LiteralPath $ReleasePath).Path
if ((Split-Path -Parent $cardRelease) -ne 'D:\DevSpace-Goal-PoC\.poc\replan-v1\releases' -or (Split-Path -Leaf $cardRelease) -notmatch '^chat-goal-card-preview-\d{8}-\d{2}$') { throw 'Not an isolated card release.' }
if ((& $NodeExe -p 'process.versions.node.split(String.fromCharCode(46))[0]') -ne '24') { throw 'Existing dependencies require Node 24; do not rebuild.' }
$cardManifest = Get-Content -LiteralPath (Join-Path $cardRelease 'release-manifest.json') -Raw | ConvertFrom-Json
foreach ($cardFile in $cardManifest.files.PSObject.Properties) {
  $cardTarget = [IO.Path]::GetFullPath((Join-Path $cardRelease $cardFile.Name))
  if (-not $cardTarget.StartsWith($cardRelease + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path is outside release.' }
  if ((Get-FileHash -LiteralPath $cardTarget -Algorithm SHA256).Hash -ine $cardFile.Value) { throw "Candidate hash mismatch: $($cardFile.Name)" }
}
$cardEnvironment = @{
  TEMP='D:\DevSpace-Goal-PoC\.poc\replan-v1\chat-tests'
  TMP='D:\DevSpace-Goal-PoC\.poc\replan-v1\chat-tests'
  DEVSPACE_CHAT_TEST_ROOT='D:\DevSpace-Goal-PoC\.poc\replan-v1\chat-tests'
  DEVSPACE_CHAT_TEST_DIST='1'
  DEVSPACE_CARD_TEST_SERVER_ENTRY=(Join-Path $cardRelease 'dist\server.js')
  DEVSPACE_GOAL_CARD_TEST_SERVER_ENTRY=([Uri](Join-Path $cardRelease 'dist\server.js')).AbsoluteUri
  DEVSPACE_CHAT_TEST_DATA_ROOT='D:\AgentState\_poc\shrimp\chat-goals-tests'
  DEVSPACE_CHAT_TEST_SHRIMP_ENTRY='D:\DevSpace-Goal-PoC\dist\index.js'
}
$cardSavedEnvironment = @{}
foreach ($cardKey in $cardEnvironment.Keys) {
  $cardSavedEnvironment[$cardKey] = [Environment]::GetEnvironmentVariable($cardKey,'Process')
  [Environment]::SetEnvironmentVariable($cardKey,$cardEnvironment[$cardKey],'Process')
}
Push-Location -LiteralPath $cardRepo
try {
  & $NodeExe --import tsx --test --test-concurrency=1 'src/chat-card-http.test.ts' 'src/chat-goal-http.test.ts'
  if ($LASTEXITCODE -ne 0) { throw 'Packaged card HTTP acceptance failed.' }
} finally {
  Pop-Location
  foreach ($cardKey in $cardEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($cardKey,$cardSavedEnvironment[$cardKey],'Process')
  }
}
