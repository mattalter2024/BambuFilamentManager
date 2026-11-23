@echo off
title Bambu P2S Filament Manager (AMS 2 Pro / AMS HT)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 (
    echo.
    echo Server exited with an error. Press any key to close...
    pause >nul
)
