# GPX-Tourenverwaltung - minimaler statischer Webserver fuer Windows.
# Braucht nur Windows-PowerShell (vorinstalliert), keine weitere Software.
# Start:  Rechtsklick auf start-webapp.bat  ODER
#         powershell -ExecutionPolicy Bypass -File serve.ps1
param([int]$Port = 8000)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $root.EndsWith('\')) { $root += '\' }

# ersten freien Port aus einer Liste nehmen
$ports = @($Port, 8010, 8080, 4173)
$chosen = $null
foreach ($p in $ports) {
  $inUse = $false
  try {
    $c = [System.Net.Sockets.TcpClient]::new()
    $c.Connect("127.0.0.1", $p); $inUse = $true; $c.Close()
  } catch { $inUse = $false }
  if (-not $inUse) { $chosen = $p; break }
}
if (-not $chosen) { $chosen = $Port }

$prefix = "http://localhost:$chosen/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "Konnte den Server nicht starten ($prefix): $_"
  Read-Host "Enter zum Schliessen"
  exit 1
}

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".map"  = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".gpx"  = "application/gpx+xml"
  ".ico"  = "image/x-icon"
  ".webmanifest" = "application/manifest+json"
}

Write-Host "GPX-Tourenverwaltung"
Write-Host "Server laeuft auf: $prefix"
Write-Host "Dieses Fenster offen lassen. Beenden mit Strg+C."
Write-Host ""

# Edge / Chrome bevorzugt (fuer den dauerhaften Ordnerzugriff noetig)
$opened = $false
foreach ($b in @("msedge.exe", "chrome.exe")) {
  try { Start-Process $b $prefix -ErrorAction Stop; $opened = $true; break } catch {}
}
if (-not $opened) { try { Start-Process $prefix } catch {} }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
      $rel = $rel -replace '/', '\'
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

      if ($full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $full -PathType Leaf)) {
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.Headers["Cache-Control"] = "no-cache"
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
      }
    } catch {
      $ctx.Response.StatusCode = 500
    } finally {
      $ctx.Response.Close()
    }
  }
} finally {
  $listener.Stop()
}
