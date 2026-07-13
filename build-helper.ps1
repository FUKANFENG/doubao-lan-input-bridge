$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root ".helper-venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Python)) {
    py -3 -m venv $Venv
}

& $Python -m pip install --upgrade pip
& $Python -m pip install pyinstaller

$Dist = Join-Path $Root "helper-dist"
$Build = Join-Path $Root "helper-build"
if (Test-Path -LiteralPath $Dist) { Remove-Item -LiteralPath $Dist -Recurse -Force }
if (Test-Path -LiteralPath $Build) { Remove-Item -LiteralPath $Build -Recurse -Force }

& $Python -m PyInstaller `
    --onefile `
    --name "key_helper" `
    --distpath $Dist `
    --workpath $Build `
    --specpath $Root `
    (Join-Path $Root "helper\key_helper.py")

Write-Host "Built helper: $Dist\key_helper.exe"
