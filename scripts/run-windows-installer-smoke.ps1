param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$Architecture
)

$ErrorActionPreference = "Stop"
$resolvedInstaller = (Resolve-Path $InstallerPath).Path
$installDirectory = Join-Path $env:RUNNER_TEMP "FlowWeave-$Architecture"
$applicationPath = Join-Path $installDirectory "FlowWeave.exe"
$uninstallerPath = Join-Path $installDirectory "Uninstall FlowWeave.exe"

if (Test-Path $installDirectory) {
  Remove-Item $installDirectory -Recurse -Force
}

$installer = Start-Process `
  -FilePath $resolvedInstaller `
  -ArgumentList @("/S", "/D=$installDirectory") `
  -Wait `
  -PassThru
if ($installer.ExitCode -ne 0) {
  throw "FlowWeave installer exited with code $($installer.ExitCode)."
}
if (-not (Test-Path $applicationPath)) {
  throw "Installed FlowWeave executable was not found at $applicationPath."
}

$smoke = Start-Process `
  -FilePath $applicationPath `
  -ArgumentList "--flowweave-smoke-test" `
  -Wait `
  -PassThru
if ($smoke.ExitCode -ne 0) {
  throw "Installed FlowWeave smoke test exited with code $($smoke.ExitCode)."
}
if (-not (Test-Path $uninstallerPath)) {
  throw "FlowWeave uninstaller was not found at $uninstallerPath."
}

$uninstaller = Start-Process `
  -FilePath $uninstallerPath `
  -ArgumentList "/S" `
  -Wait `
  -PassThru
if ($uninstaller.ExitCode -ne 0) {
  throw "FlowWeave uninstaller exited with code $($uninstaller.ExitCode)."
}
