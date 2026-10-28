$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskDist = Join-Path $taskRoot 'dist'
$taskPackage = Join-Path $taskDist 'UI5-Technical-Lens'
New-Item -ItemType Directory -Force -Path $taskPackage | Out-Null
$taskFiles = @('manifest.json', 'background.js', 'bridge.js', 'core.js', 'data-inspector.js', 'controller-inspector.js', 'inspector.js', 'popup.html', 'popup.css', 'popup.js', 'README.md', 'PRIVACY.md', 'icons')
foreach ($taskFile in $taskFiles) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskPackage -Recurse -Force }
Compress-Archive -Path (Join-Path $taskPackage '*') -DestinationPath (Join-Path $taskDist 'UI5-Technical-Lens.zip') -Force
Write-Output (Join-Path $taskDist 'UI5-Technical-Lens.zip')
