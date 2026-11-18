# scripts/capture-roccat.ps1 — USBPcap capture control for the RE session.
#
# Usage:
#   powershell -File scripts\capture-roccat.ps1 -Start      … start capture (all root hubs)
#   powershell -File scripts\capture-roccat.ps1 -Stop       … stop capture
#   powershell -File scripts\capture-roccat.ps1 -List       … list USBPcap root hubs
#
# Requires USBPcap (https://desowin.org/usbpcap/ — or bundled with Wireshark)
# and an elevated PowerShell (admin) because the USBPcap service needs it.
#
# Protocol sources for this RE workflow:
#   - https://github.com/FortisVoluntas/roccat-burst-pro-air-linux-tool (same method:
#     capture official Swarm while it changes settings, then rebuild packets)
#   - https://github.com/audiovideo1979-sys/roccat-manager (capture_all.bat /
#     parse_usbpcap.py — the capture scripts this one is modelled on)

param(
  [switch]$Start,
  [switch]$Stop,
  [switch]$List,
  [string]$OutDir = "$PSScriptRoot\..\captures",
  [int]$DurationSec = 0,
  [string]$Stamp = ""
)

$usbpcapPaths = @(
  "C:\Program Files\USBPcap\USBPcapCMD.exe",
  "C:\Program Files\Wireshark\USBPcapCMD.exe",
  "C:\Program Files (x86)\USBPcap\USBPcapCMD.exe"
)
$usbpcap = $usbpcapPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $usbpcap) {
  Write-Output "[error] USBPcapCMD.exe not found. Install USBPcap (desowin.org/usbpcap) or Wireshark with the USBPcap component."
  exit 1
}
Write-Output "[i] USBPcap: $usbpcap"

if ($Stop) {
  $killed = @(Get-Process -Name USBPcapCMD -ErrorAction SilentlyContinue)
  if ($killed.Count -eq 0) {
    Write-Output "[i] no running capture"
  } else {
    $killed | ForEach-Object { Stop-Process -Id $_.Id -Force }
    Write-Output ("[i] stopped {0} capture process(es)" -f $killed.Count)
  }
  exit 0
}

if ($List) {
  & $usbpcap -l
  exit 0
}

if (-not $Start) {
  Write-Output "usage: -Start / -Stop / -List"
  exit 0
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not $Stamp) { $Stamp = Get-Date -Format "yyyyMMdd-HHmmss" }

# clean up stale captures from a previous session (needs this shell elevated)
Get-Process -Name USBPcapCMD -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

# one-time init for USB 3.0 capture (registry key; safe, idempotent)
& $usbpcap -I 2>$null | Out-Null

$started = 0
1..8 | ForEach-Object {
  $n = $_
  $dev = "\\.\USBPcap$n"
  $out = Join-Path $OutDir ("hub{0}-{1}.pcap" -f $n, $Stamp)
  $p = Start-Process -FilePath $usbpcap -ArgumentList "-d",$dev,"-o",$out,"-s","65535","-A","--inject-descriptors" -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 200
  if (-not $p.HasExited) {
    $script:started += 1
    Write-Output "[+] capturing $dev -> $out"
  }
}
if ($started -eq 0) {
  Write-Output "[error] could not start any capture — is this shell elevated (admin)?"
  exit 1
}

$sessionInfo = @{
  stamp = $Stamp
  hubs = $started
  startedAt = (Get-Date -Format o)
  durationSec = $DurationSec
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $OutDir "session-$Stamp.json") -Value $sessionInfo
Write-Output ""
Write-Output "=== CAPTURE RUNNING (hub files: captures\hub*-$Stamp.pcap) ==="
Write-Output "Now change settings in ROCCAT Swarm one at a time (3s between actions)."

if ($DurationSec -gt 0) {
  Write-Output "Auto-stop in $DurationSec seconds …"
  $deadline = (Get-Date).AddSeconds($DurationSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (-not (Get-Process -Name USBPcapCMD -ErrorAction SilentlyContinue)) { break }
  }
  Get-Process -Name USBPcapCMD -ErrorAction SilentlyContinue | Stop-Process -Force
  Set-Content -Path (Join-Path $OutDir "done-$Stamp.txt") -Value (Get-Date -Format o)
  Write-Output "capture finished: captures\hub*-$Stamp.pcap"
  Write-Output "This window closes automatically."
} else {
  Write-Output "When finished, stop with:  powershell -File scripts\capture-roccat.ps1 -Stop"
}
