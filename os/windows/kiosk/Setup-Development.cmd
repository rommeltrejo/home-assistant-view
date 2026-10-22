@echo off
setlocal DisableDelayedExpansion
echo DEVELOPMENT: explicitly accepting unsigned code. Not a trusted release.
"%~dp0HA.View.Kiosk.exe" setup-development
set "result=%errorlevel%"
if not "%result%"=="0" echo FAILED. No successful install is claimed. Keep the diagnostic log printed above.
pause
exit /b %result%
