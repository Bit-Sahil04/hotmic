# Installs the HotMic LAN helper (Chrome native messaging host) for the current user.
# Usage:  powershell -ExecutionPolicy Bypass -File native-host\install-windows.ps1 [-ExtensionId <id>]
param(
  [string]$ExtensionId = 'ijjmpbibipdmmloibgobofjoindgplop'
)
$ErrorActionPreference = 'Stop'
$HostName = 'com.hotmic.lan'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 18+ is required (https://nodejs.org). Install it, then re-run this script.' }
$major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 18) { throw "Node.js 18+ is required (found $major)." }

$installDir = Join-Path $env:LOCALAPPDATA 'HotMic'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item (Join-Path $here 'hotmic_host.mjs') $installDir -Force

$utf8 = New-Object System.Text.UTF8Encoding $false   # no BOM
$cmdPath = Join-Path $installDir 'hotmic_host.cmd'
[System.IO.File]::WriteAllText($cmdPath, "@echo off`r`n`"$node`" `"%~dp0hotmic_host.mjs`" %*`r`n", $utf8)

$manifestPath = Join-Path $installDir "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'HotMic LAN discovery helper'
  path            = $cmdPath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8)

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath

Write-Host "Installed $HostName for extension $ExtensionId"
Write-Host "  helper:   $installDir"
Write-Host "  manifest: $manifestPath"
Write-Host ''
Write-Host 'Windows Defender Firewall may ask to allow Node.js on the network the first time;'
Write-Host 'allow it on Private networks so nearby devices can be discovered.'
