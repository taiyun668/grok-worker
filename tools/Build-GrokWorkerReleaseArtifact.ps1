[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$')] [string] $Version,
  [Parameter(Mandatory)] [string] $OutputDirectory,
  [string] $SourceRoot,
  [switch] $RequireTaggedSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-DeterministicZip([string] $InputRoot, [string] $ZipPath, [DateTimeOffset] $Timestamp) {
  Add-Type -AssemblyName System.IO.Compression
  $stream = [IO.File]::Open($ZipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $files = Get-ChildItem -LiteralPath $InputRoot -File -Recurse | Sort-Object { $_.FullName.Substring($InputRoot.Length + 1).Replace('\', '/') }
      foreach ($file in $files) {
        $relative = $file.FullName.Substring($InputRoot.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $Timestamp
        $input = [IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) }
        finally { $output.Dispose(); $input.Dispose() }
      }
    }
    finally { $archive.Dispose() }
  }
  finally { $stream.Dispose() }
}

if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw "OutputDirectory already exists: $OutputDirectory" }
if ((& git -C $SourceRoot status --porcelain=v1 --untracked-files=all | Out-String).Trim()) { throw 'SourceRoot must be a clean Git worktree.' }

$commitTimeText = (& git -C $SourceRoot show -s --format=%cI HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to read source commit time.' }
$commitTime = [DateTimeOffset]::Parse($commitTimeText)
if ($commitTime.Year -lt 1980) { $commitTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero) }

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("grok-worker-release-" + [Guid]::NewGuid().ToString('N'))
$firstTree = Join-Path $temporaryRoot 'first'
$secondTree = Join-Path $temporaryRoot 'second'
$firstZip = Join-Path $temporaryRoot 'first.zip'
$secondZip = Join-Path $temporaryRoot 'second.zip'
try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
  $tagSwitch = @{}
  if ($RequireTaggedSource) { $tagSwitch.RequireTaggedSource = $true }
  & (Join-Path $PSScriptRoot 'New-GrokWorkerProviderRelease.ps1') -Version $Version -OutputRoot $firstTree -SourceRoot $SourceRoot @tagSwitch | Out-Null
  & (Join-Path $PSScriptRoot 'New-GrokWorkerProviderRelease.ps1') -Version $Version -OutputRoot $secondTree -SourceRoot $SourceRoot @tagSwitch | Out-Null
  & (Join-Path $PSScriptRoot 'Test-GrokWorkerProviderRelease.ps1') -ReleasePath $firstTree | Out-Null
  & (Join-Path $PSScriptRoot 'Test-GrokWorkerProviderRelease.ps1') -ReleasePath $secondTree | Out-Null
  New-DeterministicZip $firstTree $firstZip $commitTime
  New-DeterministicZip $secondTree $secondZip $commitTime
  $firstHash = Get-Sha256 $firstZip
  $secondHash = Get-Sha256 $secondZip
  if ($firstHash -ne $secondHash) { throw 'Two clean builds from the same commit produced different ZIP hashes.' }

  New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
  $archiveName = "grok-worker-provider-$Version.zip"
  $archivePath = Join-Path $OutputDirectory $archiveName
  Copy-Item -LiteralPath $firstZip -Destination $archivePath
  $checksumName = "$archiveName.sha256"
  $checksumPath = Join-Path $OutputDirectory $checksumName
  [IO.File]::WriteAllText($checksumPath, "$firstHash  $archiveName`n", [Text.UTF8Encoding]::new($false))
  [pscustomobject]@{
    pass = $true
    version = $Version
    archive = $archivePath
    checksum = $checksumPath
    sha256 = $firstHash
    reproducibleBuilds = 2
  }
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
