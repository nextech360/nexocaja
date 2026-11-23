@echo off
chcp 65001 >nul
title Instalador de NexoCaja
cd /d "%~dp0"
echo.
echo  ==============================================
echo     NexoCaja - Instalacion (solo una vez)
echo     Creado por Erick Nex - NexTech360
echo  ==============================================
echo.

where winget >nul 2>&1
if errorlevel 1 (
  echo  Falta "Instalador de aplicacion" de Microsoft ^(winget^).
  echo  Se abrira la Microsoft Store: instalalo o actualizalo y vuelve a abrir instalar.bat
  start "" "ms-windows-store://pdp/?productid=9NBLGGH4NNS1"
  pause
  exit /b 1
)

set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs;%PATH%"

rem ---- Node.js LTS (incluye la base de datos SQLite que usa NexoCaja) ----
where node >nul 2>&1
if errorlevel 1 (
  echo  Instalando Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
) else (
  node -e "require('node:sqlite')" >nul 2>&1
  if errorlevel 1 (
    echo  Tu Node.js es muy viejo para NexoCaja. Actualizando a la version LTS...
    winget upgrade -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  ) else (
    echo  Node.js ya esta instalado.
  )
)

set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs;%PATH%"

rem ---- Ajustes propios de esta instalacion (.env) ----
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  Se creo el archivo .env de esta instalacion ^(puerto, carpeta de datos, caja^).
) else (
  echo  Ya existe .env ^(no se toca^).
)

echo.
echo  ---- Revision final ----
set "FALTA=0"
where node >nul 2>&1
if errorlevel 1 (
  set "FALTA=1"
  echo  [ ] Node.js aun no aparece ^(normal si se acaba de instalar^).
) else (
  node -e "require('node:sqlite')" >nul 2>&1
  if errorlevel 1 (
    set "FALTA=1"
    echo  [ ] Node.js instalado pero viejo. Reinicia la PC y vuelve a abrir instalar.bat
  ) else (
    for /f "delims=" %%v in ('node -v') do echo  [OK] Node.js %%v
  )
)

echo.
if "%FALTA%"=="0" (
  echo  Listo. Ahora abre iniciar.bat
) else (
  echo  Reinicia la PC y abre iniciar.bat
)
echo.
pause
