@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in PATH.
  echo Install Node.js LTS from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

set OPEN_BROWSER=1
echo Starting the LOCOXATL multi-page preview...
echo The server will automatically choose another port if 4173 is already in use.
node server.js

if errorlevel 1 pause
endlocal
