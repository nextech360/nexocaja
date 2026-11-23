#!/usr/bin/env sh
# NexoCaja · Instalación en Linux / macOS (solo una vez). No usa npm ni dependencias.
cd "$(dirname "$0")" || exit 1
echo ""
echo "  =============================================="
echo "     NexoCaja - Instalación"
echo "  =============================================="
if ! command -v node >/dev/null 2>&1; then
  echo "  Falta Node.js 22.13 o superior."
  echo "    Ubuntu/Debian:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "    macOS:          brew install node@22"
  exit 1
fi
if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "  Tu Node.js ($(node -v)) es muy viejo: NexoCaja necesita 22.13 o superior."
  exit 1
fi
echo "  [OK] Node.js $(node -v)"
chmod +x iniciar.sh actualizar.sh 2>/dev/null
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  [OK] Se creó .env (revísalo: puerto, carpeta de datos, caja)."
else
  echo "  [OK] Ya existe .env (no se toca)."
fi
echo ""
echo "  Listo. Arranca con:  ./iniciar.sh"
