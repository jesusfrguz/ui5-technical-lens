$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskDist = Join-Path $taskRoot 'dist'
$taskPackage = Join-Path $taskDist 'UI5-Technical-Lens'
New-Item -ItemType Directory -Force -Path $taskPackage | Out-Null
$taskFiles = @('manifest.json', 'background.js', 'bridge.js', 'core.js', 'data-inspector.js', 'controller-inspector.js', 'event-inspector.js', 'devtools.html', 'devtools.js', 'source-locator.js', 'inspector.js', 'popup.html', 'popup.css', 'popup.js', 'README.md', 'PRIVACY.md', 'icons', 'vendor')
foreach ($taskFile in $taskFiles) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskPackage -Recurse -Force }
Compress-Archive -Path (Join-Path $taskPackage '*') -DestinationPath (Join-Path $taskDist 'UI5-Technical-Lens.zip') -Force
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'manifest.json') -Raw | ConvertFrom-Json).version
$taskDownloads = Join-Path $taskRoot 'downloads'
New-Item -ItemType Directory -Force -Path $taskDownloads | Out-Null
Copy-Item -LiteralPath (Join-Path $taskDist 'UI5-Technical-Lens.zip') -Destination (Join-Path $taskDownloads "UI5-Technical-Lens-$taskVersion.zip") -Force
Write-Output (Join-Path $taskDist 'UI5-Technical-Lens.zip')
Write-Output (Join-Path $taskDownloads "UI5-Technical-Lens-$taskVersion.zip")
