@echo off
chcp 65001 >nul
title Actualizar NexoCaja
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>&1 || (echo No encuentro Node.js. Ejecuta primero instalar.bat & pause & exit /b 1)
node actualizar.mjs
pause
