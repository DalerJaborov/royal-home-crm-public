@echo off
rem Royal Home office bridge: launcher. Keep this file next to install-office-bridge.ps1.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo PowerShell not found at %PS%
  echo Tell Claude: powershell.exe missing, Windows version is:
  ver
  pause
  exit /b 1
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-office-bridge.ps1"
