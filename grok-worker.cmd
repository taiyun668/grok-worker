@echo off
setlocal EnableExtensions
REM Stable shim for GROK-WORKER-PROVIDER.
REM Each launch:
REM   1) Prefer GROK_WORKER_CURRENT_JSON, else %LOCALAPPDATA%\GrokWorkerProvider\current.json
REM   2) Node bootstrap validates pointer shape and wires dataRoot/registryPath (env wins)
REM   3) Legacy GrokUI worker-provider / worker-profiles roots are preserved when pointer absent
REM   4) Never reads auth.json; never switches OAuth accounts; never touches D:\Grok UI runtime
REM Release flow: write immutable releases\<version>, verify manifest SHA-256, then atomic-replace current.json only.

if not defined GROK_WORKER_CURRENT_JSON (
  if defined LOCALAPPDATA (
    set "GROK_WORKER_CURRENT_JSON=%LOCALAPPDATA%\GrokWorkerProvider\current.json"
  )
)

node "%~dp0bin\grok-worker.js" %*
exit /b %errorlevel%
