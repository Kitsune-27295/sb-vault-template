# Second Brain Nightly Sync Automation Script
# Usage in Windows Task Scheduler: powershell -ExecutionPolicy Bypass -File ./run-nightly-sync.ps1

param(
  [string]$VaultPath = "."
)

Write-Host "[Second Brain] Running Nightly Watchtower Sync on $VaultPath..."
node ./bin/sb.js sync-repos --ingest --vault $VaultPath
Write-Host "[Second Brain] Nightly Sync Complete."

