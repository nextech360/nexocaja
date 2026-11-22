# NexoCaja · Punto de Venta DGII

App web local en Node.js (sin dependencias de npm) que corre en la PC del negocio
(Windows 10/11) y se abre en el navegador en **http://localhost:3360**.
Se instala una vez y se actualiza sola con el botón **Actualizar** dentro de la app
(mismo modelo que ClipSphere).

## Archivos

```
instalar.bat        una sola vez: instala Node.js LTS con winget
iniciar.bat         abre la app (node --watch … server.js --open)
reiniciar.bat       cierra la ventana de NexoCaja y la vuelve a abrir
server.js           servidor (node:http) + rutas /api/…
lib/config.js       lee/crea config.json (ajustes de cada negocio)
lib/db.js           SQLite incluido en Node (node:sqlite), migraciones y respaldos
lib/updater.js      actualización desde GitHub (manifest + sha256)
migraciones/        001_init.sql, 002_… (solo se agregan, nunca se editan)
public/             interfaz (index.html, app.js, styles.css)
make-manifest.js    script del autor: genera manifest.json antes de cada push
manifest.json       versión + notas + sha256 de cada archivo
LEEME-PRIMERO.txt   instrucciones para quien lo instala
LICENCIA.txt        licencia de uso
```

**Nunca se suben ni se actualizan:** `config.json`, `datos/` (BD y respaldos), certificados, logs.

## Requisitos

- Windows 10/11 con winget (instalar.bat lo verifica).
- Node.js **22.13 o superior** (trae `node:sqlite`). `instalar.bat` instala la LTS.

## Publicar una versión nueva

```bash
# 1. Si cambia la BD, agrega migraciones/00X_lo_que_sea.sql (nunca edites una publicada)
node make-manifest.js 1.0.1 "Lo que cambió" "Otra mejora"
git add -A
git commit -m "NexoCaja 1.0.1 — lo que cambió"
git push origin main
```
En pocos minutos, a todos los que tienen la app abierta les sale el botón **Actualizar**.

Qué pasa al actualizar: respaldo de la BD → baja solo los archivos que cambiaron →
verifica SHA-256 → copia (lib/ y server.js al final) → `--watch` reinicia →
al arrancar se aplican las migraciones nuevas (con otro respaldo antes).

## Primera instalación de un cliente

Pásale el ZIP del repo (GitHub → Code → Download ZIP) y que siga `LEEME-PRIMERO.txt`.

## Varios negocios en la misma PC

Una carpeta de NexoCaja por negocio, cada una con su `config.json`
(`puerto` distinto: 3360, 3361…). Cada una tiene su propia carpeta `datos/`.

---
NexoCaja © 2026 · Creado por **Erick Nex** · **NexTech**360
