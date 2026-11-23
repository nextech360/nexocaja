# NexoCaja · Instalación independiente

Cada instalación de NexoCaja es **independiente**: tiene su propia base de datos, sus propios ajustes (`.env` y `config.json`), sus usuarios, sus productos y sus secuencias fiscales. Las actualizaciones llegan solo desde las versiones oficiales publicadas en `github.com/nextech360/nexocaja` y **nunca** tocan los datos ni los ajustes de la máquina.

## Qué es de cada instalación (nunca se sube ni se actualiza)

| Archivo / carpeta | Qué guarda |
|---|---|
| `.env` | Puerto, carpeta de datos, nombre de la caja (lo creas tú a partir de `.env.example`) |
| `config.json` | Claves internas generadas solas (sesiones y cifrado del certificado) |
| carpeta de datos (`datos/` o la de `NX_CARPETA_DATOS`) | Base de datos SQLite, respaldos, XML de e-CF, certificado `.p12` **cifrado** |

## Requisitos

- **Windows 10/11:** nada; `instalar.bat` instala Node.js LTS con winget.
- **Linux / macOS / servidor:** Node.js **22.13 o superior** (trae SQLite incluido). No usa npm.

## Instalar

### Windows
1. Descarga el ZIP oficial y extráelo, por ejemplo en `C:\NexoCaja`.
2. Doble clic en **`instalar.bat`**: instala Node.js y crea `.env`.
3. (Opcional) Abre `.env` con el Bloc de notas y ajusta puerto, carpeta de datos y caja.
4. Doble clic en **`iniciar.bat`**: abre `http://localhost:3360`.

### Linux / macOS
```sh
git clone --depth 1 https://github.com/nextech360/nexocaja.git nexocaja   # o descarga el ZIP
cd nexocaja
./instalar.sh        # revisa Node.js y crea .env
nano .env            # ajusta NX_PUERTO, NX_CARPETA_DATOS, NX_CAJA
./iniciar.sh         # http://localhost:3360
```

Como servicio de systemd (servidor), `/etc/systemd/system/nexocaja.service`:
```ini
[Unit]
Description=NexoCaja
After=network-online.target

[Service]
WorkingDirectory=/opt/nexocaja
ExecStart=/opt/nexocaja/iniciar.sh
Restart=always
User=nexocaja

[Install]
WantedBy=multi-user.target
```

## Primera vez (cada instalación)

1. Crea el **dueño** con su PIN (pantalla de bienvenida).
2. **Configuración fiscal:** razón social, nombre comercial, **RNC**, dirección, teléfono y correo.
3. Elige el modo de comprobantes. Para e-CF: sube el **certificado `.p12`** y registra las **secuencias** que la DGII autorizó a ESE negocio.
4. **Usuarios:** crea cajeros y supervisores.
5. **Productos:** carga tu catálogo.
6. Haz una venta de prueba y revisa el ticket (Configuración fiscal → Impresión del ticket → Vista previa).

## Actualizar

- Desde la app: botón **Actualizar** (barra amarilla).
- Sin abrir la app: **`actualizar.bat`** (Windows) o **`./actualizar.sh`** (Linux/macOS).
  - Si NexoCaja está abierto, pide usar el botón o cerrarlo primero.
  - Hace un respaldo de la base de datos antes de cambiar archivos.
  - Verifica el SHA-256 de cada archivo contra el `manifest.json` oficial.
  - Nunca toca `.env`, `config.json`, la carpeta de datos ni los certificados.
- Los cambios de base de datos (migraciones) se aplican al abrir NexoCaja, con respaldo automático antes.

## Varias instalaciones en la misma PC (pruebas)

Usa una carpeta por instalación y en cada `.env` un **puerto** y una **carpeta de datos** distintos:
```
C:\NexoCaja-Pruebas\.env   →  NX_PUERTO=3370   NX_CARPETA_DATOS=D:\NexoCajaDatos\Pruebas
```

## Seguridad

- El certificado `.p12` se sube desde la pantalla y queda **cifrado** (AES-256-GCM) con una clave que solo existe en `config.json` de esa máquina.
- Para mover una instalación a otra PC: copia **juntos** `config.json`, `.env` y la carpeta de datos. Sin `config.json` el certificado cifrado no se puede abrir (súbelo de nuevo).
- Respaldos: copia la carpeta de datos (incluye `respaldos/`) a un disco externo o a la nube con regularidad.
- `NX_HOST=127.0.0.1` si nadie más en la red debe entrar a esa caja.
