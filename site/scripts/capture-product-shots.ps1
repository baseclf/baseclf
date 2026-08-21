$ErrorActionPreference = "Stop"

$siteRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$outputRoot = Join-Path $siteRoot "public\product-shots"
$edgeCandidates = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge was not found." }

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$shots = @(
  @{ Name = "overview"; Route = "/studio/overview" },
  @{ Name = "policy-studio"; Route = "/studio" },
  @{ Name = "new-project"; Route = "/studio/new-project" },
  @{ Name = "provisioning"; Route = "/studio/provisioning" },
  @{ Name = "api-explorer"; Route = "/studio/api" },
  @{ Name = "request-logs"; Route = "/studio/logs" },
  @{ Name = "deployments"; Route = "/studio/deployments" },
  @{ Name = "backups"; Route = "/studio/backups" }
)

foreach ($shot in $shots) {
  $profile = Join-Path $siteRoot ".capture-$($shot.Name)"
  $output = Join-Path $outputRoot "$($shot.Name).png"
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  $arguments = @(
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1600,1000",
    "--virtual-time-budget=2500",
    "--run-all-compositor-stages-before-draw",
    "--user-data-dir=`"$profile`"",
    "--screenshot=`"$output`"",
    "http://localhost:3000$($shot.Route)"
  )
  Start-Process -FilePath $edge -ArgumentList $arguments -Wait -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path -LiteralPath $output); $attempt++) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $output)) { throw "Capture failed: $($shot.Name)" }
  $resolvedProfile = (Resolve-Path -LiteralPath $profile).Path
  if (-not $resolvedProfile.StartsWith($siteRoot + [IO.Path]::DirectorySeparatorChar)) { throw "Capture profile escaped the site root." }
  Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
}

& node (Join-Path $PSScriptRoot "optimize-product-shots.mjs")
if ($LASTEXITCODE -ne 0) { throw "Product screenshot optimization failed." }

Write-Output "Captured and optimized $($shots.Count) product screenshots in $outputRoot"
