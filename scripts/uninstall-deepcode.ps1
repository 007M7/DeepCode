<#
.SYNOPSIS
Removes the current user's globally linked DeepCode CLI.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npm 'uninstall' '--global' '@deepseek-ai/dsh'
if ($LASTEXITCODE -ne 0) {
  throw "npm exited with code $LASTEXITCODE."
}
Write-Host 'DeepCode was removed. The standard npm command directory remains on PATH for other global tools.'
