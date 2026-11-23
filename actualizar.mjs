// NexoCaja · Actualizador de línea de comandos (equivale al botón «Actualizar»).
// Baja solo la versión OFICIAL publicada, verifica el SHA-256 de cada archivo y
// NUNCA toca .env, config.json, la carpeta de datos ni los certificados.
// Uso:  node actualizar.mjs            → actualiza si hay versión nueva
//       node actualizar.mjs --revisar  → solo dice si hay versión nueva
import { loadConfig, appVersion } from './lib/config.js';

process.removeAllListeners('warning');
const cfg = loadConfig();
const soloRevisar = process.argv.includes('--revisar');

async function abierto() {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.puerto}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

const updater = await import('./lib/updater.js');
let info;
try { info = await updater.check(); } catch (e) {
  console.error(`\n  ✖ No se pudo revisar si hay versión nueva: ${e.message}\n`);
  process.exit(1);
}
console.log(`\n  Versión instalada: v${info.current} · Versión oficial: v${info.latest}`);
if (!info.available) { console.log('  ✔ NexoCaja ya está al día.\n'); process.exit(0); }
if (info.notes.length) console.log('  Novedades:\n' + info.notes.map((n) => `    - ${n}`).join('\n'));
if (soloRevisar) process.exit(0);

if (await abierto()) {
  console.log(`\n  NexoCaja está abierto (puerto ${cfg.puerto}). Usa el botón «Actualizar» dentro de la app,`);
  console.log('  o ciérralo y vuelve a ejecutar este actualizador.\n');
  process.exit(2);
}

const plan = await updater.prepare((m) => console.log(m));
// Respaldo de la base de datos de ESTA instalación antes de tocar archivos
try {
  const db = await import('./lib/db.js');
  db.openDb(cfg, appVersion());
  console.log('  Respaldo: ' + db.backup('antes-de-actualizar'));
  db.closeDb();
} catch (e) { console.log(`  (sin respaldo previo: ${e.message})`); }
const r = updater.commit(plan);
console.log(`\n  ✔ Actualizado a v${r.version} (${r.changed} archivos).`);
console.log('    Los cambios de base de datos se aplican solos (con respaldo) al abrir NexoCaja.\n');
