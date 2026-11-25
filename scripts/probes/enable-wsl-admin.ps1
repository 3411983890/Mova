$ErrorActionPreference = 'Continue'
$log = 'C:\Users\34119\Documents\Mova\qa\wsl-admin.log'
Start-Transcript -Path $log -Force

Write-Output "=== elevation ==="
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "admin=$admin"

Write-Output "=== enable Windows features ==="
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

Write-Output "=== configure WSL service ==="
sc.exe config WslService start= auto
sc.exe start WslService
Get-Service -Name WslService | Format-List Name,Status,StartType

Write-Output "=== wsl status ==="
wsl.exe --status
wsl.exe --version

Write-Output "=== docker service ==="
sc.exe config com.docker.service start= auto
sc.exe start com.docker.service
Get-Service -Name com.docker.service | Format-List Name,Status,StartType

Write-Output "=== done ==="
Stop-Transcript
