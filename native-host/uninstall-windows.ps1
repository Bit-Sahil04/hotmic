$ErrorActionPreference = 'SilentlyContinue'
$HostName = 'com.hotmic.lan'
Remove-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" -Recurse -Force
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'HotMic') -Recurse -Force
Write-Host "Removed $HostName"
