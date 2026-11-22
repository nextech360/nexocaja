// Ajustes de ESTA instalación. Viven en config.json (nunca se sube ni se actualiza).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  puerto: 3360,
  // 0.0.0.0 permite abrirlo desde otras cajas/tablets de la red. 127.0.0.1 = solo esta PC.
  host: '0.0.0.0',
  // Carpeta de la base de datos y respaldos. Relativa a la app o ruta completa (ej. D:\\NexoCajaDatos)
  carpetaDatos: 'datos',
  respaldosAGuardar: 15,
  caja: 'CAJA-01',
  empresa: {
    razonSocial: 'Mi Negocio SRL',
    nombreComercial: 'Mi Negocio',
    rnc: '',
    sucursal: 'Principal',
    direccion: '',
    telefono: '',
    regimen: 'ORDINARIO'
  },
  dgii: {
    ambiente: 'TesteCF',
    // Nombre del .p12 dentro de carpetaDatos/certs. La contraseña se guarda cifrada en la BD.
    certificado: ''
  },
  claves: {
    sesion: '',
    cifradoCertificado: ''
  }
};

function secret() {
  return crypto.randomBytes(36).toString('base64url');
}

function merge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
}

/** Guarda config.json de forma segura: primero .guardando, luego renombra (con .bak del anterior). */
export function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.guardando';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  fs.renameSync(tmp, CONFIG_PATH);
}

export function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      // config.json dañado: intentar con el respaldo
      user = JSON.parse(fs.readFileSync(CONFIG_PATH + '.bak', 'utf8'));
    }
  }
  const cfg = merge(DEFAULTS, user);
  let changed = !fs.existsSync(CONFIG_PATH);
  if (!cfg.claves.sesion || cfg.claves.sesion.length < 32) { cfg.claves.sesion = secret(); changed = true; }
  if (!cfg.claves.cifradoCertificado || cfg.claves.cifradoCertificado.length < 32) { cfg.claves.cifradoCertificado = secret(); changed = true; }
  // Agrega al archivo los ajustes nuevos que traiga una versión más reciente, sin tocar los del usuario
  if (JSON.stringify(Object.keys(user).sort()) !== JSON.stringify(Object.keys(cfg).sort())) changed = true;
  if (changed) saveConfig(cfg);

  cfg.dirDatos = path.isAbsolute(cfg.carpetaDatos) ? cfg.carpetaDatos : path.join(ROOT, cfg.carpetaDatos);
  return cfg;
}

export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
