#!/usr/bin/env sh
# NexoCaja · Actualizar desde la versión oficial publicada (sin abrir la app).
cd "$(dirname "$0")" || exit 1
exec node actualizar.mjs "$@"
