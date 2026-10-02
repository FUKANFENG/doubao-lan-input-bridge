param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$Dist = Join-Path $Root "dist"
$Build = Join-Path $Root "build"

if (-not (Test-Path -LiteralPath $Python)) {
    py -3 -m venv $Venv
}

& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $Root "requirements.txt")

if ($Clean) {
    if (Test-Path -LiteralPath $Dist) { Remove-Item -LiteralPath $Dist -Recurse -Force }
    if (Test-Path -LiteralPath $Build) { Remove-Item -LiteralPath $Build -Recurse -Force }
}

& $Python -m PyInstaller `
    --onefile `
    --windowed `
    --name "DoubaoLanInputBridge" `
    --distpath $Dist `
    --workpath $Build `
    --specpath $Root `
    (Join-Path $Root "gui_app.py")

Write-Host "Built: $Dist\DoubaoLanInputBridge.exe"
