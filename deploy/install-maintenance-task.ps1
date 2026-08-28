# Grok Worker Provider - install maintenance scheduled task (disabled by default).
# Pure ASCII. Does not enable the task. Does not run a real probe.
$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.Name
$sid = $identity.User.Value
$shim = Join-Path $env:USERPROFILE ".local\bin\grok-worker.cmd"
$wd = Join-Path $env:LOCALAPPDATA "GrokWorkerProvider"
$start = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")

function Escape-XmlValue {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  $out = $Value
  $out = $out -replace "&", "&amp;"
  $out = $out -replace "<", "&lt;"
  $out = $out -replace ">", "&gt;"
  return $out
}

$templatePath = Join-Path $PSScriptRoot "GrokWorkerProviderMaintenance.template.xml"
if (-not (Test-Path -LiteralPath $templatePath)) {
  throw "missing template: GrokWorkerProviderMaintenance.template.xml"
}
$tpl = Get-Content -LiteralPath $templatePath -Raw -Encoding UTF8

$xml = $tpl
$xml = $xml.Replace("{{USERID}}", (Escape-XmlValue $user))
$xml = $xml.Replace("{{START_BOUNDARY}}", $start)
$xml = $xml.Replace("{{SHIM_PATH}}", (Escape-XmlValue $shim))
$xml = $xml.Replace("{{WORKING_DIR}}", (Escape-XmlValue $wd))

if ($xml -match "\{\{|}}") {
  throw "unrendered placeholder"
}

if (-not (Test-Path -LiteralPath $wd)) {
  New-Item -ItemType Directory -Path $wd -Force | Out-Null
}
$out = Join-Path $wd "GrokWorkerProviderMaintenance.xml"
$utf16 = New-Object System.Text.UnicodeEncoding $false, $true
[System.IO.File]::WriteAllText($out, $xml, $utf16)

# No run-as flag: principal comes from task XML (InteractiveToken); avoids password prompt.
& schtasks.exe /Create /TN "GrokWorkerProviderMaintenance" /XML "$out" /F
if ($LASTEXITCODE -ne 0) {
  throw "create failed"
}
& schtasks.exe /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
if ($LASTEXITCODE -ne 0) {
  throw "disable failed - do NOT report success"
}

# schtasks normalizes UserId to a SID; verify principal via task-namespace XML, not username regex.
$q = (& schtasks.exe /Query /TN "GrokWorkerProviderMaintenance" /XML) -join "`n"
$doc = New-Object System.Xml.XmlDocument
$doc.XmlResolver = $null
$doc.LoadXml($q)
$nsmgr = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
$nsmgr.AddNamespace("task", "http://schemas.microsoft.com/windows/2004/02/mit/task")
$principalUserId = $doc.SelectSingleNode("//task:Principals/task:Principal/task:UserId", $nsmgr)
if ($null -eq $principalUserId -or $principalUserId.InnerText -ne $sid) {
  throw "post-install principal SID mismatch"
}
$runLevel = $doc.SelectSingleNode("//task:Principals/task:Principal/task:RunLevel", $nsmgr)
# schtasks omits the explicit LeastPrivilege node when it normalizes to the
# platform default.  Reject an explicit non-default elevation, but accept the
# omitted/default representation.
if ($null -ne $runLevel -and $runLevel.InnerText -ne "LeastPrivilege") {
  throw "post-install run level mismatch"
}
$needles = @(
  "PT30M",
  "IgnoreNew",
  "InteractiveToken",
  "cmd.exe",
  "pool maintenance tick"
)
foreach ($n in $needles) {
  if ($q -notmatch $n) {
    throw "post-install verify missing: $n"
  }
}

Write-Host "installed (disabled). enable only after standing authorization."
