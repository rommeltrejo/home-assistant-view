@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0payload\ha.view.exe" (
  echo HA View payload missing. Extract the whole ZIP folder before running.
  exit /b 1
)
pushd "%~dp0payload"
if errorlevel 1 exit /b 1
"%~dp0payload\ha.view.exe" %*
set "result=%errorlevel%"
popd
exit /b %result%
