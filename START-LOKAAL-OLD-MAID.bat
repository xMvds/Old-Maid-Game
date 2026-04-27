@echo off
setlocal

cd /d "%~dp0"

echo ==============================================
echo  Old Maid lokaal opstarten
echo ==============================================

where node >nul 2>&1
if errorlevel 1 (
  echo [FOUT] Node.js is niet gevonden.
  echo Installeer eerst Node.js LTS vanaf https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] node_modules niet gevonden. Dependencies worden geinstalleerd...
  call npm install
  if errorlevel 1 (
    echo [FOUT] npm install is mislukt.
    pause
    exit /b 1
  )
)

set "LOCAL_URL=http://localhost:3000/room.html"
set "HOST_URL=http://localhost:3000/host"

echo [INFO] Server wordt gestart...
echo [INFO] Player URL: %LOCAL_URL%
echo [INFO] Host URL:   %HOST_URL%

timeout /t 2 /nobreak >nul
start "" "%LOCAL_URL%"
start "" "%HOST_URL%"

call npm start

endlocal
