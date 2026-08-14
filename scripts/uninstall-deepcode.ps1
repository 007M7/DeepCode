<#
.SYNOPSIS
Removes the current user's DeepCode command shim.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmPrefix = (& $npm 'prefix' '--global').Trim()
if ($LASTEXITCODE -ne 0 -or $npmPrefix -eq '') {
  throw 'npm did not return its global command directory.'
}
foreach ($path in @(
  (Join-Path $npmPrefix 'deepseek.cmd'),
  (Join-Path $npmPrefix 'deepseek.ps1'),
  (Join-Path $npmPrefix 'deepseek')
)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
  $contents = Get-Content -LiteralPath $path -Raw
  if ($contents -notmatch 'DeepCode downloaded-source launcher') {
    throw "Refusing to remove a command not owned by DeepCode: $path"
  }
  Remove-Item -LiteralPath $path -Force
}
Write-Host 'DeepCode was removed. The standard npm command directory remains on PATH for other global tools.'
