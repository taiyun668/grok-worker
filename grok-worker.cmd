@echo off
setlocal
node "%~dp0bin\grok-worker.js" %*
exit /b %errorlevel%
