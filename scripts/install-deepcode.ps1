<#
.SYNOPSIS
Installs the repository build as the current user's global DeepCode CLI.
#>

[CmdletBinding()]
param(
  [ValidateSet('User', 'Process')]
  [string]$PathTarget = 'User',
  [switch]$SkipDependencies,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'install-deepcode.ps1 supports Windows only.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cliRoot = Join-Path $repositoryRoot 'apps\cli'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source

function Invoke-DeepCodeCommand {
  param(
    [Parameter(Mandatory)] [string]$Executable,
    [Parameter(Mandatory)] [string[]]$Arguments
  )
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Executable exited with code $LASTEXITCODE."
  }
}

function Add-DeepCodePath {
  param(
    [Parameter(Mandatory)] [string]$Directory,
    [Parameter(Mandatory)] [string]$Target
  )
  $current = [Environment]::GetEnvironmentVariable('Path', $Target)
  $entries = @($current -split ';' | Where-Object { $_.Trim() -ne '' })
  $present = $entries | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') }
  if ($null -eq $present) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $Directory) -join ';'), $Target)
  }
  if (($env:Path -split ';') -notcontains $Directory) {
    $env:Path = "$Directory;$env:Path"
  }
}

Push-Location $repositoryRoot
try {
  if (-not $SkipDependencies) {
    Invoke-DeepCodeCommand $corepack @('pnpm', 'install', '--frozen-lockfile')
  }
  if (-not $SkipBuild) {
    Invoke-DeepCodeCommand $corepack @('pnpm', 'run', 'build:lib:host')
  }
  Push-Location $cliRoot
  try {
    Invoke-DeepCodeCommand $npm @('link')
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
$npmPrefix = (& $npm 'prefix' '--global').Trim()
if ($LASTEXITCODE -ne 0 -or $npmPrefix -eq '') {
  throw 'npm did not return its global command directory.'
}

Add-DeepCodePath -Directory $npmPrefix -Target $PathTarget

$cmdShim = Join-Path $npmPrefix 'deepseek.cmd'
$powerShellShim = Join-Path $npmPrefix 'deepseek.ps1'
if (-not (Test-Path -LiteralPath $cmdShim -PathType Leaf)) {
  throw "The expected command shim was not installed: $cmdShim"
}

# PowerShell resolves a same-name .ps1 before .cmd and refuses that script
# under Restricted policy. The .cmd shim works in both shells without changing
# the user's policy, so the downloaded-source installer exposes one shared shim.
Remove-Item -LiteralPath $powerShellShim -Force -ErrorAction SilentlyContinue

$cmdVersion = (& $cmdShim '--version').Trim()
if ($LASTEXITCODE -ne 0 -or $cmdVersion -eq '') {
  throw 'The CMD deepseek shim failed its version check.'
}
$escapedCmdShim = $cmdShim.Replace("'", "''")
$powerShellVersion = (& powershell.exe -NoProfile -ExecutionPolicy Restricted -Command "& '$escapedCmdShim' --version").Trim()
if ($LASTEXITCODE -ne 0 -or $powerShellVersion -ne $cmdVersion) {
  throw 'PowerShell could not run the shared deepseek.cmd shim.'
}

if ($PathTarget -eq 'User') {
  Add-Type -Namespace DeepCodeInstaller -Name EnvironmentBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
  IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
  uint flags, uint timeout, out UIntPtr result);
'@
  $broadcastResult = [UIntPtr]::Zero
  [void][DeepCodeInstaller.EnvironmentBroadcast]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
}

Write-Host "DeepCode $cmdVersion installed successfully."
Write-Host "Global command directory: $npmPrefix"
Write-Host 'Open a new CMD, PowerShell, or Windows Terminal window and run: deepseek'
Write-Host "Keep this repository at its current path: $repositoryRoot"
