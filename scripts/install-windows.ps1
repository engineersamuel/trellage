[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path $PSScriptRoot -Parent
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($bun) {
    $bunPath = $bun.Source
} elseif (Get-Command mise -ErrorAction SilentlyContinue) {
    Push-Location $env:USERPROFILE
    try { $bunPath = (& mise which bun --tool bun@1.4.4).Trim() }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Install Bun 1.4.4 with mise install bun@1.4.4 first.' }
} else {
    throw 'Bun 1.4.4 is required on PATH.'
}
if ((& $bunPath --version) -ne '1.4.4') { throw 'Trellage requires Bun 1.4.4.' }
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0'
$runtimeArgs = @('--no-install', '--no-env-file', "--config=$(Join-Path $sourceRoot 'packages\trellage-runtime\bunfig.toml')")
$workspaceCli = Join-Path $sourceRoot 'packages\trellage-runtime\src\workspace-cli.ts'
& $bunPath @runtimeArgs $workspaceCli prepare-runtime $sourceRoot
if ($LASTEXITCODE -ne 0) { throw 'Source preparation failed; use a private checkout under your user profile.' }
$commandDirectory = Join-Path $env:USERPROFILE '.local\bin'
[System.IO.Directory]::CreateDirectory($commandDirectory) | Out-Null
& $bunPath @runtimeArgs $workspaceCli validate-command-directory $commandDirectory
if ($LASTEXITCODE -ne 0) { throw 'Native Windows command directory is unsafe.' }
$launcher = Join-Path $commandDirectory 'trx.cmd'
$entrypoint = Join-Path $sourceRoot 'bin\trx.ts'
$configuration = Join-Path $sourceRoot 'packages\trellage-runtime\bunfig.toml'
# A .ps1 shim consumes the user's bare -- separator before Bun can see it.
$oldLauncher = Join-Path $commandDirectory 'trx.ps1'
if (Test-Path $oldLauncher) { Remove-Item -LiteralPath $oldLauncher -Force }
$batch = @(
    '@rem Managed by Trellage Windows installer.'
    '@echo off'
    'setlocal'
    'set "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"'
    'if not defined HOME set "HOME=%USERPROFILE%"'
    'set "TRELLAGE_TRX_COMMAND_PATH=%~f0"'
    ('"' + $bunPath.Replace('%', '%%') + '" --no-install --no-env-file "--config=' + $configuration.Replace('%', '%%') + '" "' + $entrypoint.Replace('%', '%%') + '" -- %*')
    'exit /b %errorlevel%'
) -join "`r`n"
[System.IO.File]::WriteAllText($launcher, $batch + "`r`n", [System.Text.UTF8Encoding]::new($false))
& $bunPath @runtimeArgs $workspaceCli validate-command-directory $commandDirectory
if ($LASTEXITCODE -ne 0) { throw 'The generated launcher inherited unsafe Windows permissions.' }
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $userPath) { $userPath = '' }
if ($commandDirectory -notin ($userPath -split ';')) {
    [Environment]::SetEnvironmentVariable('PATH', ($userPath.TrimEnd(';') + ';' + $commandDirectory), 'User')
}
Write-Output "Installed native trx: $launcher"
