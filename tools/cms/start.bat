@echo off
REM Kevin's Place CMS launcher
REM Double-click to start the CMS server in your default browser.

cd /d "%~dp0"
echo Starting Kevin's Place CMS...
echo.
node cms.js
pause
