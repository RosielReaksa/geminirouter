@echo off
REM ============================================================
REM  geminirouter website system launcher (fully parallel to
REM  the installed Antigravity Manager desktop app)
REM
REM  Starts:
REM    1) The patched core with its OWN profile at
REM       core-profile\.antigravity-agent (fresh accounts, added
REM       via the website) and gateway on port 8046
REM    2) The web bridge on port 3000, connected to that core
REM
REM  Your installed desktop app (port 8045, its own accounts)
REM  keeps running independently. No connection between them.
REM ============================================================
setlocal
set "ROOT=%~dp0.."
if defined CORE_HOME (
  set "CORE_REPO=%CORE_HOME%"
) else (
  set "CORE_REPO=%ROOT%\core"
)
set "SITE_HOME=%ROOT%\core-profile"

if not exist "%CORE_REPO%\dist\core\main.cjs" (
  echo [ERROR] Core bundle not found at %CORE_REPO%\dist\core\main.cjs
  echo         Install the AntigravityManager core and set CORE_HOME to its directory.
  pause
  exit /b 1
)

REM Read the website system's API key (gitignored file)
set "API_KEY="
for /f "usebackq delims=" %%k in (`type "%SITE_HOME%\API_KEY.txt"`) do set "API_KEY=%%k"
if "%API_KEY%"=="" (
  echo [ERROR] %SITE_HOME%\API_KEY.txt not found.
  pause
  exit /b 1
)

REM Read custom OAuth client credentials if present (gitignored file)
set "CUSTOM_OAUTH="
if exist "%SITE_HOME%\OAUTH_CLIENT.env" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%SITE_HOME%\OAUTH_CLIENT.env") do (
    if "%%a"=="ANTIGRAVITY_OAUTH_CLIENTS" set "ANTIGRAVITY_OAUTH_CLIENTS=%%~b"
    if "%%a"=="ANTIGRAVITY_OAUTH_CLIENT_KEY" set "ANTIGRAVITY_OAUTH_CLIENT_KEY=%%~b"
  )
)

echo [1/2] Starting patched core (profile: core-profile, gateway: 8046)...
start "geminirouter-core" cmd /c "cd /d %CORE_REPO% && set USERPROFILE=%SITE_HOME%&& set HOME=%SITE_HOME%&& set ANTIGRAVITY_OAUTH_CLIENTS=%ANTIGRAVITY_OAUTH_CLIENTS%&& set ANTIGRAVITY_OAUTH_CLIENT_KEY=%ANTIGRAVITY_OAUTH_CLIENT_KEY%&& node dist\core\main.cjs"

ping 127.0.0.1 -n 6 >nul

echo [2/2] Starting web bridge (dashboard: http://localhost:3000)...
start "geminirouter-bridge" cmd /c "cd /d %ROOT%\server && set USERPROFILE=%SITE_HOME%&& set HOME=%SITE_HOME%&& set GEMINIROUTER_GATEWAY_PORT=8046&& set GEMINIROUTER_GATEWAY_API_KEY=%API_KEY%&& node dist\index.js"

echo.
echo ============================================================
echo   geminirouter is running!
echo   Dashboard: http://localhost:3000
echo   API Gateway: http://localhost:8046/v1
echo ============================================================
