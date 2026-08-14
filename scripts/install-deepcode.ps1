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
$node = (Get-Command node.exe -ErrorAction Stop).Source

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
} finally {
  Pop-Location
}
$npmPrefix = (& $npm 'prefix' '--global').Trim()
if ($LASTEXITCODE -ne 0 -or $npmPrefix -eq '') {
  throw 'npm did not return its global command directory.'
}

Add-DeepCodePath -Directory $npmPrefix -Target $PathTarget

$cmdShim = Join-Path $npmPrefix 'deepseek.cmd'
$posixShim = Join-Path $npmPrefix 'deepseek'
$powerShellShim = Join-Path $npmPrefix 'deepseek.ps1'
$legacyPackage = Join-Path $npmPrefix 'node_modules\@deepseek-ai\dsh'
$selfLink = Join-Path $cliRoot 'node_modules\@deepseek-ai\dsh'

# Older installers used `npm link`, which can create a package junction back
# into its own node_modules tree. Remove only links that resolve to this CLI.
foreach ($candidate in @($legacyPackage, $selfLink)) {
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "Refusing to replace a non-link path: $candidate"
  }
  $targets = @($item.Target | ForEach-Object {
    if ([IO.Path]::IsPathRooted($_)) { [IO.Path]::GetFullPath($_) }
    else { [IO.Path]::GetFullPath((Join-Path $item.Parent.FullName $_)) }
  })
  if ($targets -notcontains [IO.Path]::GetFullPath($cliRoot)) {
    throw "Refusing to replace a link not owned by this checkout: $candidate"
  }
  [IO.Directory]::Delete($candidate)
}

# A direct command shim avoids an npm package self-link while preserving the
# downloaded-source workflow. PowerShell resolves the same .cmd under Restricted
# policy, so no .ps1 launcher is created.
$escapedNode = $node.Replace('%', '%%')
$escapedEntry = (Join-Path $cliRoot 'lib\deepseek.js').Replace('%', '%%')
$cmdContents = @"
@echo off
rem DeepCode downloaded-source launcher
"$escapedNode" "$escapedEntry" %*
exit /b %errorlevel%
"@
[IO.File]::WriteAllText($cmdShim, $cmdContents, [Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $powerShellShim -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $posixShim -Force -ErrorAction SilentlyContinue
foreach ($legacyShim in @('dsh', 'dsh.cmd', 'dsh.ps1')) {
  $legacyPath = Join-Path $npmPrefix $legacyShim
  if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) { continue }
  if ((Get-Content -LiteralPath $legacyPath -Raw) -match 'node_modules[/\\]@deepseek-ai[/\\]dsh') {
    Remove-Item -LiteralPath $legacyPath -Force
  }
}

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
