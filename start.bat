@echo off
setlocal
title Explorer Share - host (close this window to end the session)
cd /d "%~dp0"
chcp 65001 >nul

set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if "%NODE%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Node.js is not installed. Download it from https://nodejs.org and run start.bat again.
    echo.
    pause
    exit /b 1
  )
)

if not exist "node_modules\ws\package.json" (
  echo.
  echo   First run: installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Could not install dependencies. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem The session runs inside this window. Every drive on this PC is visible to everyone in it.
"%NODE%" server\index.js %*

echo.
echo   Explorer Share has stopped. Press any key to close this window.
pause >nul
