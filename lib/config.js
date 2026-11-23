// Ajustes de ESTA instalación. Viven en config.json (nunca se sube ni se actualiza).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const ENV_PATH = path.join(ROOT, '.env');

/**
 * Carga .env (si existe) en process.env sin pisar variables ya definidas.
 * Formato: CLAVE=valor por línea; # comentarios; comillas opcionales. Sin dependencias.
 */
export function loadDotEnv(file = ENV_PATH) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return out;
}
// Se carga al importar este módulo, antes que el actualizador y la conexión con la DGII.
loadDotEnv();

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

  // Variables de entorno / .env: mandan sobre config.json en ESTA máquina (no se guardan en el archivo).
  const env = process.env;
  if (env.NX_PUERTO) cfg.puerto = Number(env.NX_PUERTO) || cfg.puerto;
  if (env.NX_HOST) cfg.host = env.NX_HOST;
  if (env.NX_CARPETA_DATOS) cfg.carpetaDatos = env.NX_CARPETA_DATOS;
  if (env.NX_CAJA) cfg.caja = env.NX_CAJA;
  if (env.NX_RESPALDOS) cfg.respaldosAGuardar = Number(env.NX_RESPALDOS) || cfg.respaldosAGuardar;

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
