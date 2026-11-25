<#
.SYNOPSIS
  Register (or unregister) the colab-bridge Antigravity plugin at global or workspace scope.
.DESCRIPTION
  Supports three clean, non-destructive modes:
    - GlobalLink (default): creates a directory junction at ~\.gemini\config\plugins\colab-bridge
      pointing to this plugin root (no admin rights required, stays live-synced across all workspaces).
    - GlobalCopy: copies the plugin bundle into ~\.gemini\config\plugins\colab-bridge.
    - WorkspaceJson: merges an entry into <WorkspaceRoot>\.agents\plugins.json.
  Never edits ~\.gemini\config\config.json.
#>
[CmdletBinding()]
param(
  [ValidateSet('GlobalCopy', 'GlobalLink', 'WorkspaceJson')]
  [string]$Mode = 'GlobalCopy',
  [string]$WorkspaceRoot = '',
  [string]$GlobalPluginName = 'colab-bridge',
  [switch]$DryRun,
  [switch]$Unregister,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $ScriptDir)).Path
$PluginDirName = Split-Path -Leaf $PluginRoot

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  $WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $PluginRoot)
}
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

function Write-Info([string]$Msg) { Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg)   { Write-Host "[ OK ] $Msg" -ForegroundColor Green }
function Write-Err([string]$Msg)  { Write-Host "[ERR ] $Msg" -ForegroundColor Red }

$manifestPath = Join-Path $PluginRoot 'plugin.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-Err "Missing plugin.json at $manifestPath"
  exit 2
}

if ($Mode -eq 'WorkspaceJson') {
  $agentsDir = Join-Path $WorkspaceRoot '.agents'
  $pluginsJsonPath = Join-Path $agentsDir 'plugins.json'
  $pluginParent = Split-Path -Parent $PluginRoot
  $baseUri = New-Object System.Uri(($WorkspaceRoot.TrimEnd('\', '/') + '\'))
  $targetUri = New-Object System.Uri(($pluginParent.TrimEnd('\', '/') + '\'))
  $entryPath = [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).TrimEnd('/')

  $doc = [ordered]@{}
  $entries = New-Object System.Collections.Generic.List[object]
  if (Test-Path -LiteralPath $pluginsJsonPath) {
    $parsed = Get-Content -LiteralPath $pluginsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($prop in $parsed.PSObject.Properties) {
      if ($prop.Name -eq 'entries' -and $null -ne $prop.Value) {
        foreach ($e in @($prop.Value)) { $entries.Add($e) }
      } else {
        $doc[$prop.Name] = $prop.Value
      }
    }
  }

  $kept = New-Object System.Collections.Generic.List[object]
  $found = $false
  foreach ($e in $entries) {
    $inc = if ($e.PSObject.Properties.Name -contains 'include_only' -and $null -ne $e.include_only) { @($e.include_only) } else { @() }
    if ([string]$e.path -eq $entryPath -and $inc.Count -eq 1 -and [string]$inc[0] -eq $PluginDirName) {
      $found = $true
      if (-not $Unregister) { $kept.Add($e) }
    } else {
      $kept.Add($e)
    }
  }
  if (-not $Unregister -and -not $found) {
    $kept.Add([ordered]@{ path = $entryPath; include_only = @($PluginDirName) })
  }
  $doc['entries'] = @($kept.ToArray())
  $outJson = ($doc | ConvertTo-Json -Depth 10) + "`n"

  if ($DryRun) {
    Write-Ok "Dry-run preview for $pluginsJsonPath :"
    Write-Host $outJson
    exit 0
  }
  if (-not (Test-Path -LiteralPath $agentsDir)) {
    New-Item -ItemType Directory -Path $agentsDir -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($pluginsJsonPath, $outJson, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "Updated $pluginsJsonPath"
  exit 0
}

$globalPluginsDir = Join-Path $HOME '.gemini\config\plugins'
$targetDir = Join-Path $globalPluginsDir $GlobalPluginName

if ($Unregister) {
  if (-not (Test-Path -LiteralPath $targetDir)) {
    Write-Info "Global plugin not found: $targetDir"
    exit 0
  }
  if ($DryRun) {
    Write-Ok "Dry-run would remove $targetDir"
    exit 0
  }
  $item = Get-Item -LiteralPath $targetDir -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    [System.IO.Directory]::Delete($targetDir)
  } else {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
  }
  Write-Ok "Removed $targetDir"
  exit 0
}

if ($Mode -eq 'GlobalLink') {
  if (Test-Path -LiteralPath $targetDir) {
    if (-not $Force) {
      Write-Err "Already exists: $targetDir (pass -Force or -Unregister)."
      exit 3
    }
    if (-not $DryRun) {
      $existing = Get-Item -LiteralPath $targetDir -Force
      if ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        [System.IO.Directory]::Delete($targetDir)
      } else {
        Remove-Item -LiteralPath $targetDir -Recurse -Force
      }
    }
  }
  if ($DryRun) {
    Write-Ok "Dry-run ($Mode): $targetDir ==> $PluginRoot"
    exit 0
  }
  if (-not (Test-Path -LiteralPath $globalPluginsDir)) {
    New-Item -ItemType Directory -Path $globalPluginsDir -Force | Out-Null
  }
  New-Item -ItemType Junction -Path $targetDir -Target $PluginRoot | Out-Null
  Write-Ok "Created junction: $targetDir ==> $PluginRoot"
} else {
  if ((Test-Path -LiteralPath $targetDir) -and (-not $Force)) {
    Write-Err "Already exists: $targetDir (pass -Force to sync in-place, or -Unregister)."
    exit 3
  }
  if ($DryRun) {
    Write-Ok "Dry-run ($Mode): sync $PluginRoot ==> $targetDir"
    exit 0
  }
  if (-not (Test-Path -LiteralPath $globalPluginsDir)) {
    New-Item -ItemType Directory -Path $globalPluginsDir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $targetDir) {
    $existing = Get-Item -LiteralPath $targetDir -Force
    if ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      [System.IO.Directory]::Delete($targetDir)
    }
  }
  if (-not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  }
  # Overwrite files in-place so live file-watchers on the plugin root do not fail sync.
  Get-ChildItem -LiteralPath $PluginRoot -Force | ForEach-Object {
    if ($_.Name -in @('.git', 'node_modules')) { return }
    Copy-Item -LiteralPath $_.FullName -Destination $targetDir -Recurse -Force
  }
  Write-Ok "Synced plugin bundle in-place to $targetDir"
}
exit 0
