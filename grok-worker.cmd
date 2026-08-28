@echo off
setlocal EnableExtensions
REM Stable shim for GROK-WORKER-PROVIDER.
REM Each launch validates the pointer, resolves its immutable releasePath, then
REM starts that release's Node bootstrap. It never reads auth.json, changes
REM accounts, or falls back to a repository-local provider implementation.

if not defined GROK_WORKER_CURRENT_JSON (
  if defined LOCALAPPDATA (
    set "GROK_WORKER_CURRENT_JSON=%LOCALAPPDATA%\GrokWorkerProvider\current.json"
  )
)

if not defined GROK_WORKER_CURRENT_JSON (
  echo GROK_WORKER_POINTER_MISSING 1>&2
  exit /b 2
)

for /f "usebackq delims=" %%R in (`node -e "const fs=require('fs'); const path=require('path'); const p=process.argv[1]; let v; try { v=JSON.parse(fs.readFileSync(p,'utf8')); } catch (_) { process.exit(2); } if (!v || typeof v.releasePath!=='string' || !v.releasePath || typeof v.version!=='string' || !v.version || typeof v.dataRoot!=='string' || !v.dataRoot || typeof v.registryPath!=='string' || !v.registryPath || typeof v.approvedProfileRoot!=='string' || !v.approvedProfileRoot || !fs.existsSync(path.join(v.releasePath,'bin','grok-worker.js'))) process.exit(2); process.stdout.write(v.releasePath);" "%GROK_WORKER_CURRENT_JSON%"`) do set "GROK_WORKER_RELEASE=%%R"

if not defined GROK_WORKER_RELEASE (
  echo GROK_WORKER_POINTER_INVALID 1>&2
  exit /b 2
)

node "%GROK_WORKER_RELEASE%\bin\grok-worker.js" %*
exit /b %errorlevel%
