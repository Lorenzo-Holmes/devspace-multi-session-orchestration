param(
    [string]$NodePath = 'D:\DevSpace\node-v24.20.0-win-x64\node.exe',
    [switch]$SkipFullTypecheck
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runDir = Join-Path $root ('docs\native-external-goal\evidence\run-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$result = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString('o')
    nodePath = $NodePath
    nodeIdentity = $null
    nativeModuleExitCode = $null
    testsExitCode = $null
    isolatedTypecheckExitCode = $null
    fullTypecheckExitCode = $null
    fullTypecheckSkipped = [bool]$SkipFullTypecheck
    offlineAuditExitCode = $null
    nativeEndToEnd = 'not_run'
    productionDeployment = 'not_performed'
    verifiedScope = 'TypeScript client + real SQLite intent journal + protocol fixtures; NOT a native runtime test'
    status = 'running'
}
$exitCode = 1
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Invoke-NodeStep {
    param([string[]]$Arguments, [string]$LogName)
    $lines = @(& $NodePath @Arguments 2>&1)
    $code = $LASTEXITCODE
    $text = ($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $runDir $LogName), $text + [Environment]::NewLine, $utf8)
    foreach ($line in $lines) { Write-Host $line }
    return [int]$code
}
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
Push-Location $root
try {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Required project Node executable is missing.' }
    $identity = & $NodePath -p 'JSON.stringify({version:process.version,abi:process.versions.modules})'
    if ($LASTEXITCODE -ne 0) { throw 'Node identity check failed.' }
    $result.nodeIdentity = $identity | ConvertFrom-Json
    & $NodePath -e "const DB=require('better-sqlite3'); const d=new DB(':memory:'); d.close()"
    $result.nativeModuleExitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'SQLite ABI mismatch. Use the existing matching Node; do not reinstall shared dependencies.' }

    $result.testsExitCode = Invoke-NodeStep -Arguments @('node_modules\tsx\dist\cli.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', 'src\native-external-goal.test.ts') -LogName 'tests.tap'
    $result.isolatedTypecheckExitCode = Invoke-NodeStep -Arguments @('node_modules\typescript\bin\tsc', '--noEmit', '-p', 'tsconfig.native-external-goal.json') -LogName 'typecheck-isolated.log'
    if (-not $SkipFullTypecheck) {
        $result.fullTypecheckExitCode = Invoke-NodeStep -Arguments @('node_modules\typescript\bin\tsc', '--noEmit', '-p', 'tsconfig.json') -LogName 'typecheck-full.log'
    }
    $result.offlineAuditExitCode = Invoke-NodeStep -Arguments @('node_modules\tsx\dist\cli.mjs', 'scripts\audit-native-external-goal.ts') -LogName 'offline-audit.json'
    $passed = ($result.testsExitCode -eq 0 -and $result.isolatedTypecheckExitCode -eq 0 -and
        $result.offlineAuditExitCode -eq 0 -and ($SkipFullTypecheck -or $result.fullTypecheckExitCode -eq 0))
    if ($passed) { $result.status = 'passed_for_declared_scope'; $exitCode = 0 }
    else { $result.status = 'failed' }
} catch {
    $result.status = 'failed'
    $result.error = $_.Exception.Message
} finally {
    $result.finishedAt = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $runDir 'result.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
    Pop-Location
}
Write-Output ('Evidence: ' + $runDir)
Write-Output ('Result: ' + $result.status + '; native end-to-end: not_run')
exit $exitCode
