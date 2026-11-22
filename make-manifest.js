// Script del AUTOR: genera manifest.json antes de cada push.
// Uso:  node make-manifest.js 1.2.0 "Nota 1" "Nota 2"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const [version, ...notes] = process.argv.slice(2);

if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Uso: node make-manifest.js 1.2.0 "Nota 1" "Nota 2"');
  process.exit(1);
}

const SKIP_NAMES = new Set(['config.json', 'config.json.bak', 'errores.log', 'manifest.json', 'node_modules', '.git', '_update_tmp', 'datos', 'respaldos', 'certs', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SKIP_EXT = ['.new', '.guardando', '.log', '.db', '.db-wal', '.db-shm', '.p12', '.pfx', '.pem', '.key'];

// Mantener package.json con la misma versión (se escribe ANTES de calcular los hashes)
const pkgPath = path.join(ROOT, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
}

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_NAMES.has(entry.name)) continue;
    if (SKIP_EXT.some((e) => entry.name.endsWith(e))) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(abs); continue; }
    if (!entry.isFile()) continue;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    files.push({ path: rel, sha256 });
  }
}
walk(ROOT);

const manifest = {
  version,
  date: new Date().toISOString().slice(0, 10),
  notes,
  files
};
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json → v${version} · ${files.length} archivos`);
notes.forEach((n) => console.log(`  - ${n}`));
