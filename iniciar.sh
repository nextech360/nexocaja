#!/usr/bin/env sh
# NexoCaja · Arranque en Linux / macOS. Se reinicia solo después de actualizar.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "No encuentro Node.js. Ejecuta primero ./instalar.sh"; exit 1; }
exec node --watch-path=lib --watch-path=server.js server.js "$@"
