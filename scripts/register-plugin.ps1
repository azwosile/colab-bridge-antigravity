<#
.SYNOPSIS
  Register (or unregister) the colab-bridge Antigravity plugin at global or workspace scope.
.DESCRIPTION
  Supports three clean, non-destructive modes:
    - GlobalCopy (default): copies the plugin bundle into ~\.gemini\config\plugins\colab-bridge
      while preserving any existing local.config.json (and preservePaths declared in agy-market.json).
    - GlobalLink: creates a directory junction at ~\.gemini\config\plugins\colab-bridge
      pointing to this plugin root (no admin rights required, stays live-synced across all workspaces).
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
  function Get-PreserveRelPaths([string]$RootDir) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    [void]$set.Add('local.config.json')
    $marketManifest = Join-Path $RootDir 'agy-market.json'
    if (Test-Path -LiteralPath $marketManifest) {
      try {
        $parsed = Get-Content -LiteralPath $marketManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $parsed -and ($parsed.PSObject.Properties.Name -contains 'preservePaths') -and $null -ne $parsed.preservePaths) {
          foreach ($raw in @($parsed.preservePaths)) {
            $rel = (([string]$raw).Trim().Replace('\', '/') -replace '^(\./)+', '') -replace '/+$', ''
            if (-not [string]::IsNullOrWhiteSpace($rel) -and (-not $rel.Contains('..')) -and (-not $rel.StartsWith('/'))) {
              [void]$set.Add($rel)
            }
          }
        }
      } catch {
        Write-Info "Could not parse agy-market.json preservePaths; defaulting to local.config.json"
      }
    }
    return ,$set
  }

  $preservePaths = Get-PreserveRelPaths $PluginRoot
  $excludedDirs = @('.git', 'node_modules', '__pycache__', 'tmp')

  if ((Test-Path -LiteralPath $targetDir) -and (-not $Force)) {
    Write-Err "Already exists: $targetDir (pass -Force to sync in-place, or -Unregister)."
    exit 3
  }
  if ($DryRun) {
    Write-Ok "Dry-run ($Mode): sync $PluginRoot ==> $targetDir (preserving existing: $($preservePaths -join ', '))"
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

  function Sync-DirectoryInPlace([string]$SourceDir, [string]$RelPrefix) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $SourceDir -Force)) {
      if ($entry.PSIsContainer) {
        if ($entry.Name -in $excludedDirs) { continue }
        $nextRel = if ([string]::IsNullOrEmpty($RelPrefix)) { $entry.Name } else { "$RelPrefix/$($entry.Name)" }
        Sync-DirectoryInPlace -SourceDir $entry.FullName -RelPrefix $nextRel
      } else {
        if ($entry.Name.EndsWith('.pyc', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $relPosix = if ([string]::IsNullOrEmpty($RelPrefix)) { $entry.Name } else { "$RelPrefix/$($entry.Name)" }
        $destFile = Join-Path $targetDir ($relPosix -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        if ($preservePaths.Contains($relPosix) -and (Test-Path -LiteralPath $destFile)) {
          Write-Info "Preserved existing $relPosix at $destFile"
          continue
        }
        $destParent = Split-Path -Parent $destFile
        if (-not (Test-Path -LiteralPath $destParent)) {
          New-Item -ItemType Directory -Path $destParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $entry.FullName -Destination $destFile -Force
      }
    }
  }

  # Overwrite files in-place so live file-watchers on the plugin root do not fail sync,
  # while preserving existing machine-local config files (e.g. local.config.json).
  Sync-DirectoryInPlace -SourceDir $PluginRoot -RelPrefix ''
  Write-Ok "Synced plugin bundle in-place to $targetDir"
}
exit 0
