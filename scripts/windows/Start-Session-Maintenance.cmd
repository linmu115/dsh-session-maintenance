@echo off
title DSH Session Maintenance
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Session-Maintenance.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. Please keep the diagnostic message above.
  pause
  exit /b 1
)
echo.
echo Ready. You may close this window; the engine runs in the background.
timeout /t 5 >nul
