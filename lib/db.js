// Base de datos SQLite incluida en Node (node:sqlite): nada que instalar con npm.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './config.js';

const MIGRACIONES = path.join(ROOT, 'migraciones');
let db = null;
let ctx = null;

export function openDb(cfg, version) {
  fs.mkdirSync(cfg.dirDatos, { recursive: true });
  ctx = { cfg, version, file: path.join(cfg.dirDatos, 'nexocaja.db'), backups: path.join(cfg.dirDatos, 'respaldos') };
  db = new DatabaseSync(ctx.file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

export function getDb() {
  if (!db) throw new Error('La base de datos no está abierta');
  return db;
}

/** Copia completa y consistente de la BD (funciona con el sistema abierto). */
export function backup(label = 'manual') {
  fs.mkdirSync(ctx.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = String(label).replace(/[^a-z0-9._-]/gi, '_');
  const dest = path.join(ctx.backups, `nexocaja_${stamp}_v${ctx.version}_${safe}.db`);
  db.prepare('VACUUM INTO ?').run(dest);
  const files = fs.readdirSync(ctx.backups)
    .filter((f) => f.startsWith('nexocaja_') && f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(ctx.backups, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(ctx.cfg.respaldosAGuardar)) fs.rmSync(path.join(ctx.backups, f));
  return dest;
}

/**
 * Aplica las migraciones nuevas (carpeta migraciones/). Si la BD ya tenía datos,
 * hace un respaldo automático ANTES. Nunca borra datos.
 */
export function migrate(log = console.log) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const files = fs.existsSync(MIGRACIONES) ? fs.readdirSync(MIGRACIONES).filter((f) => f.endsWith('.sql')).sort() : [];
  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) return [];

  if (applied.size) log(`  Respaldo antes de actualizar la BD: ${path.basename(backup('antes-de-migrar'))}`);
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRACIONES, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
      db.exec('COMMIT');
      log(`  Migración aplicada: ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Falló la migración ${file}: ${err.message}`);
    }
  }
  return pending;
}

/** La primera vez copia los datos de la empresa de config.json. Desde la 1.3.0 se editan en Configuración fiscal. */
export function seedCompany(cfg) {
  if (db.prepare('SELECT COUNT(*) AS n FROM company').get().n) return;
  const e = cfg.empresa;
  db.prepare(`INSERT INTO company (id, legal_name, trade_name, rnc, branch, address, phone, tax_regime) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.razonSocial, e.nombreComercial, e.rnc, e.sucursal, e.direccion, e.telefono, e.regimen === 'RST' ? 'RST' : 'ORDINARIO');
}

export function schemaVersion() {
  const row = db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
  return row ? row.id : null;
}

export function closeDb() {
  try { db?.close(); } catch { /* noop */ }
}
