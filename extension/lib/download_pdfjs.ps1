# download_pdfjs.ps1 — Automated PDF.js downloader for local Manifest V3 bundling
$ErrorActionPreference = "Stop"

$pdfJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
$workerUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"

$destDir = $PSScriptRoot
$pdfJsDest = Join-Path $destDir "pdf.min.js"
$workerDest = Join-Path $destDir "pdf.worker.min.js"

Write-Host "Downloading pdf.min.js..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $pdfJsUrl -OutFile $pdfJsDest

Write-Host "Downloading pdf.worker.min.js..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $workerUrl -OutFile $workerDest

Write-Host "Successfully downloaded PDF.js files to $destDir!" -ForegroundColor Green
