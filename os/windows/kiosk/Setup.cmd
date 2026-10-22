@echo off
setlocal DisableDelayedExpansion
"%~dp0HA.View.Kiosk.exe" setup
set "result=%errorlevel%"
if not "%result%"=="0" echo FAILED. No successful install is claimed. Keep the diagnostic log printed above.
pause
exit /b %result%
