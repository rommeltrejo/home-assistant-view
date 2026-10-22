@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0kiosk\HA.View.Kiosk.exe" (
  echo Optional kiosk bundle missing. Extract the whole ZIP folder.
  exit /b 1
)
echo Optional unsigned kiosk operation. Windows protections remain unchanged.
"%~dp0kiosk\HA.View.Kiosk.exe" update-development
set "result=%errorlevel%"
if not "%result%"=="0" echo Kiosk operation failed. Keep the diagnostic log printed above.
exit /b %result%
