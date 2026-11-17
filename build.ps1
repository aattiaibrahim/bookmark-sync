# Assembles loadable extension folders into dist/.
# The two builds differ only in the manifest; all logic is shared verbatim.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }

foreach ($target in @('chromium', 'firefox')) {
    $out = Join-Path $dist $target
    New-Item -ItemType Directory -Force -Path $out | Out-Null

    Copy-Item (Join-Path $root 'src')     -Destination $out -Recurse
    Copy-Item (Join-Path $root 'options') -Destination $out -Recurse
    Copy-Item (Join-Path $root "manifests\manifest.$target.json") `
              -Destination (Join-Path $out 'manifest.json')

    Write-Host "built dist/$target"
}

Write-Host ''
Write-Host 'Load them:'
Write-Host '  Chrome/Edge/Brave  chrome://extensions -> Developer mode -> Load unpacked -> dist\chromium'
Write-Host '  Firefox            about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> dist\firefox\manifest.json'
