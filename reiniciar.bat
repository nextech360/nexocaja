@echo off
chcp 65001 >nul
title Reinicio de NexoCaja
cd /d "%~dp0"
echo Cerrando NexoCaja...
rem Cierra SOLO la ventana de NexoCaja (no otras apps de Node como ClipSphere)
taskkill /F /T /FI "WINDOWTITLE eq NexoCaja*" >nul 2>&1
rem Si quedo algo escuchando en el puerto 3360, cerrarlo tambien
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3360 " ^| findstr "LISTENING"') do taskkill /F /T /PID %%p >nul 2>&1
timeout /t 2 /nobreak >nul
echo Abriendo NexoCaja...
start "NexoCaja" "%~dp0iniciar.bat"
exit /b 0
