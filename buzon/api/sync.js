// Buzón NexoCaja · NexoCaja baja lo recibido (GET) y confirma que lo guardó (POST {ack:[ids]}).
import { getJson, listPaths, remove, tenant, onlyRnc, sameSecret, json } from '../lib/store.js';

async function auth(request) {
  const rnc = onlyRnc(request.headers.get('x-rnc'));
  const t = await tenant(rnc);
  if (!t || t.disabled || !sameSecret(request.headers.get('x-api-key'), t.apiKeyHash)) return null;
  return { rnc, t };
}
export async function GET(request) {
  const a = await auth(request);
  if (!a) return json(403, { error: 'No autorizado' });
  const paths = await listPaths(`inbox/${a.rnc}/`, 25);
  const items = [];
  for (const p of paths) { const it = await getJson(p); if (it) items.push({ id: p, ...it }); }
  return json(200, { items, certVence: a.t.certVence, nombre: a.t.nombre });
}
export async function POST(request) {
  const a = await auth(request);
  if (!a) return json(403, { error: 'No autorizado' });
  let b; try { b = await request.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  const ids = (Array.isArray(b.ack) ? b.ack : []).map(String).filter((p) => p.startsWith(`inbox/${a.rnc}/`));
  await remove(ids);
  return json(200, { ok: true, borrados: ids.length });
}
