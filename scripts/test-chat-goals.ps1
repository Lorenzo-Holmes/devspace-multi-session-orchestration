param(
  [Parameter(Mandatory = $true)][string]$NodeExe
)
$ErrorActionPreference = 'Stop'
$chatRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$expectedRepo = 'D:\DevSpace-Goal-PoC\.poc\replan-v1\devspace'
if ($chatRepo -ne $expectedRepo) { throw 'This PoC runner is scoped to the isolated repository only.' }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'Node executable not found.' }
$chatNodeMajor = & $NodeExe -p 'process.versions.node.split(".")[0]'
if ($chatNodeMajor -ne '24') { throw 'This machine''s existing native dependency build requires Node 24. Do not rebuild shared node_modules.' }
$chatTestRoot = 'D:\DevSpace-Goal-PoC\.poc\replan-v1\chat-tests'
$chatDataRoot = 'D:\AgentState\_poc\shrimp\chat-goals-tests'
$chatShrimpEntry = 'D:\DevSpace-Goal-PoC\dist\index.js'
if (-not (Test-Path -LiteralPath $chatShrimpEntry -PathType Leaf)) { throw 'Original Shrimp build is missing.' }
New-Item -ItemType Directory -Path $chatTestRoot,$chatDataRoot -Force | Out-Null
$chatEnvironment = @{
  TEMP=$chatTestRoot
  TMP=$chatTestRoot
  DEVSPACE_CHAT_TEST_ROOT=$chatTestRoot
  DEVSPACE_CHAT_TEST_DATA_ROOT=$chatDataRoot
  DEVSPACE_CHAT_TEST_SHRIMP_ENTRY=$chatShrimpEntry
  DEVSPACE_CHAT_LEGACY_TASK_FILE='D:\AgentState\_poc\shrimp\tasks.json'
  DEVSPACE_CHAT_TEST_DIST='1'
}
$chatSavedEnvironment = @{}
foreach ($chatKey in $chatEnvironment.Keys) {
  $chatSavedEnvironment[$chatKey] = [Environment]::GetEnvironmentVariable($chatKey,'Process')
  [Environment]::SetEnvironmentVariable($chatKey,$chatEnvironment[$chatKey],'Process')
}
Push-Location -LiteralPath $chatRepo
try {
  & $NodeExe 'node_modules/typescript/bin/tsc' -p tsconfig.json --noEmit
  if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
  & $NodeExe 'node_modules/vite/bin/vite.js' build --logLevel warn
  if ($LASTEXITCODE -ne 0) { throw 'UI build failed.' }
  & $NodeExe 'scripts/build-chat-card.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Diagnostic card build failed.' }
  & $NodeExe 'node_modules/typescript/bin/tsc' -p tsconfig.build.json
  if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
  $chatTests = @(
    'src/chat-goal-output.test.ts','src/chat-goal-diagnostics.test.ts',
    'src/chat-goal.test.ts','src/chat-goal-cards.test.ts','src/chat-goal-http.test.ts','src/chat-card-probe.test.ts','src/chat-card-view.test.ts','src/chat-card-http.test.ts','src/goal-entry.test.ts',
    'src/goal-binding-store.test.ts','src/goal-shrimp-client.test.ts','src/goal-manager.test.ts',
    'src/config-schema.test.ts','src/config.test.ts','src/server.test.ts',
    'src/server-shutdown.test.ts','src/workspace-access.test.ts','src/oauth-store.test.ts'
  )
  & $NodeExe --import tsx --test --test-concurrency=1 @chatTests
  if ($LASTEXITCODE -ne 0) { throw 'Chat Goal acceptance or regression test failed.' }
} finally {
  Pop-Location
  foreach ($chatKey in $chatEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($chatKey,$chatSavedEnvironment[$chatKey],'Process')
  }
}
