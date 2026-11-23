// NexoCaja · Cola de envío de e-CF a la DGII (corre dentro del servidor).
// La caja nunca espera a la DGII: firma, imprime y sigue. Aquí se envía, se consulta
// el TrackId y se reintenta con espera creciente. Si no hay internet, los e-CF quedan
// en contingencia con su plazo de 72 horas.
import fs from 'node:fs';
import * as dgii from './dgii.js';
import { buildRfce } from './xml.js';
import { signWithActive, signDetailed, dataPath, relData, certProblem } from './emision.js';

const SEND_BACKOFF = [30, 120, 600, 1800, 3600];          // segundos
const CHECK_BACKOFF = [2, 5, 10, 30, 60, 300, 900, 3600];
const now = () => new Date();
const iso = (d) => d.toISOString();
const later = (sec) => iso(new Date(Date.now() + sec * 1000));

export const queue = { running: false, lastRunAt: null, authError: null, authErrorAt: null };
let DB = null, timer = null, kicked = false, current = null, soon = null;

export function startQueue(db, everyMs = 15000) {
  DB = db;
  timer = setInterval(() => run().catch(() => {}), everyMs);
  timer.unref?.();
  setTimeout(() => run().catch(() => {}), 2500).unref?.();
}
export function kick() {
  if (!DB || kicked) return;
  kicked = true;
  setTimeout(() => { kicked = false; run().catch(() => {}); }, 200).unref?.();
}

const upd = (sql, ...a) => DB.prepare(sql).run(...a);
function failNetwork(d, err) {
  const n = d.intentos + 1;
  upd(`UPDATE ecf_documents SET estado = 'en_cola', intentos = ?, proximo_intento = ?, contingencia = 1,
       limite_envio = COALESCE(limite_envio, ?), dgii_mensajes = ? WHERE id = ?`,
  n, later(SEND_BACKOFF[Math.min(n - 1, SEND_BACKOFF.length - 1)]), iso(new Date(new Date(d.created_at).getTime() + 72 * 3600 * 1000)),
  JSON.stringify([{ codigo: 'RED', valor: err.message }]), d.id);
}
function finish(d, estado, msgs, extra = {}) {
  upd(`UPDATE ecf_documents SET estado = ?, dgii_mensajes = ?, resuelto_at = ?, proximo_intento = NULL, track_id = COALESCE(?, track_id) WHERE id = ?`,
    estado, JSON.stringify(msgs || []), iso(now()), extra.trackId || null, d.id);
}

async function sendOne(d, token) {
  const amb = d.ambiente;
  const xml = fs.readFileSync(dataPath(d.xml_path), 'utf8');
  const rnc = /<RNCEmisor>(\d+)<\/RNCEmisor>/.exec(xml)[1];
  const fileName = `${rnc}${d.encf}.xml`;
  if (d.ruta === 'RFCE') {
    let rfce;
    if (d.rfce_path && fs.existsSync(dataPath(d.rfce_path))) rfce = fs.readFileSync(dataPath(d.rfce_path), 'utf8');
    else {
      rfce = signDetailed(DB, buildRfce(xml, d.codigo_seguridad)).xml;
      const f = dataPath(d.xml_path).replace(/\.xml$/, '.rfce.xml');
      fs.writeFileSync(f, rfce);
      upd('UPDATE ecf_documents SET rfce_path = ? WHERE id = ?', relData(f), d.id);
    }
    const r = await dgii.sendRfce(DB, amb, token, d.id, rfce, fileName);
    upd('UPDATE ecf_documents SET intentos = intentos + 1, enviado_at = COALESCE(enviado_at, ?) WHERE id = ?', iso(now()), d.id);
    if (r.status === 401) { dgii.dropToken(amb); upd('UPDATE ecf_documents SET estado = \'en_cola\', proximo_intento = ? WHERE id = ?', later(10), d.id); return; }
    if (r.status !== 200) return finish(d, 'rechazado', dgii.mensajes(r.data).length ? dgii.mensajes(r.data) : [{ codigo: r.status, valor: (r.text || '').slice(0, 300) }]);
    const est = dgii.mapEstado(r.data);
    if (['aceptado', 'aceptado_condicional', 'rechazado'].includes(est)) return finish(d, est, dgii.mensajes(r.data));
    upd('UPDATE ecf_documents SET estado = \'en_cola\', proximo_intento = ?, dgii_mensajes = ? WHERE id = ?', later(60), JSON.stringify(dgii.mensajes(r.data)), d.id);
    return;
  }
  const r = await dgii.sendEcf(DB, amb, token, d.id, xml, fileName);
  upd('UPDATE ecf_documents SET intentos = intentos + 1 WHERE id = ?', d.id);
  if (r.status === 401) { dgii.dropToken(amb); upd('UPDATE ecf_documents SET estado = \'en_cola\', proximo_intento = ? WHERE id = ?', later(10), d.id); return; }
  if (r.status === 200 && r.data && r.data.trackId) {
    upd(`UPDATE ecf_documents SET estado = 'en_proceso', track_id = ?, enviado_at = ?, proximo_intento = ?, intentos = 0, dgii_mensajes = NULL WHERE id = ?`,
      r.data.trackId, iso(now()), later(CHECK_BACKOFF[0]), d.id);
    return;
  }
  finish(d, 'rechazado', dgii.mensajes(r.data).length ? dgii.mensajes(r.data) : [{ codigo: r.status, valor: (r.text || '').slice(0, 300) }]);
}

async function checkOne(d, token) {
  const r = await dgii.consultaEstado(DB, d.ambiente, token, d.id, d.track_id);
  if (r.status === 401) { dgii.dropToken(d.ambiente); upd('UPDATE ecf_documents SET proximo_intento = ? WHERE id = ?', later(10), d.id); return; }
  const est = r.status === 200 ? dgii.mapEstado(r.data) : 'desconocido';
  if (['aceptado', 'aceptado_condicional', 'rechazado'].includes(est)) return finish(d, est, dgii.mensajes(r.data));
  const n = d.intentos + 1;
  upd('UPDATE ecf_documents SET intentos = ?, proximo_intento = ? WHERE id = ?', n, later(CHECK_BACKOFF[Math.min(n, CHECK_BACKOFF.length - 1)]), d.id);
}

/** Una pasada de la cola. Devuelve un resumen (útil para pruebas y para «Enviar ahora»). */
export function run() {
  if (!DB) return Promise.resolve(null);
  if (current) return current.then(() => runOnce());
  return runOnce();
}
function scheduleSoon() {
  const r = DB.prepare(`SELECT MIN(proximo_intento) AS t FROM ecf_documents WHERE estado IN ('firmado','en_cola','en_proceso','enviado')`).get();
  if (!r || !r.t) return;
  const wait = Math.max(200, new Date(r.t) - Date.now());
  if (wait > 60000) return;
  clearTimeout(soon);
  soon = setTimeout(() => run().catch(() => {}), wait + 50);
  soon.unref?.();
}
function runOnce() {
  if (current) return current;
  current = runInner().finally(() => { current = null; try { scheduleSoon(); } catch { /* noop */ } });
  return current;
}
async function runInner() {
  queue.running = true;
  const res = { sent: 0, checked: 0, errors: 0 };
  try {
    const due = iso(now());
    const toSend = DB.prepare(`SELECT * FROM ecf_documents WHERE estado IN ('firmado','en_cola') AND (proximo_intento IS NULL OR proximo_intento <= ?)
                               ORDER BY created_at LIMIT 25`).all(due);
    const toCheck = DB.prepare(`SELECT * FROM ecf_documents WHERE estado IN ('en_proceso','enviado') AND track_id IS NOT NULL
                                AND (proximo_intento IS NULL OR proximo_intento <= ?) ORDER BY created_at LIMIT 50`).all(due);
    if (!toSend.length && !toCheck.length) return res;
    if (certProblem(DB)) { queue.authError = certProblem(DB); return res; }
    const sign = signWithActive(DB);
    const byAmb = new Map();
    for (const d of [...toSend, ...toCheck]) if (!byAmb.has(d.ambiente)) byAmb.set(d.ambiente, null);
    for (const amb of byAmb.keys()) {
      try {
        byAmb.set(amb, await dgii.getToken(DB, amb, sign));
        queue.authError = null;
      } catch (err) {
        if (err.network) { for (const d of toSend.filter((x) => x.ambiente === amb)) failNetwork(d, err); }
        else {
          queue.authError = err.message; queue.authErrorAt = iso(now());
          upd(`UPDATE ecf_documents SET proximo_intento = ? WHERE ambiente = ? AND estado IN ('firmado','en_cola','en_proceso','enviado')`, later(900), amb);
        }
        res.errors++;
      }
    }
    for (const d of toSend) {
      const token = byAmb.get(d.ambiente); if (!token) continue;
      try { await sendOne(d, token); res.sent++; } catch (err) {
        res.errors++;
        if (err.network) {
          for (const x of toSend.slice(toSend.indexOf(d))) failNetwork(DB.prepare('SELECT * FROM ecf_documents WHERE id = ?').get(x.id), err);
          break;
        }
        upd('UPDATE ecf_documents SET estado = \'en_cola\', proximo_intento = ?, dgii_mensajes = ? WHERE id = ?', later(600), JSON.stringify([{ codigo: 'LOCAL', valor: err.message }]), d.id);
      }
    }
    for (const d of toCheck) {
      const token = byAmb.get(d.ambiente); if (!token) continue;
      try { await checkOne(d, token); res.checked++; } catch (err) {
        res.errors++;
        upd('UPDATE ecf_documents SET proximo_intento = ? WHERE id = ?', later(60), d.id);
        if (err.network) break;
      }
    }
    return res;
  } finally {
    queue.running = false;
    queue.lastRunAt = iso(now());
  }
}

/** Resumen para alertas y pantalla. */
export function queueSummary(db) {
  const c = Object.fromEntries(db.prepare('SELECT estado, COUNT(*) AS n FROM ecf_documents GROUP BY estado').all().map((r) => [r.estado, r.n]));
  const pend = db.prepare(`SELECT COUNT(*) AS n, MIN(limite_envio) AS limite FROM ecf_documents WHERE estado IN ('firmado','en_cola') AND contingencia = 1`).get();
  const rech = db.prepare(`SELECT COUNT(*) AS n FROM ecf_documents WHERE estado = 'rechazado' AND reemplazado_por IS NULL`).get().n;
  return {
    porEnviar: (c.firmado || 0) + (c.en_cola || 0), enProceso: (c.en_proceso || 0) + (c.enviado || 0), aceptados: (c.aceptado || 0) + (c.aceptado_condicional || 0),
    rechazados: rech, contingencia: pend.n, limiteMasCercano: pend.limite, offline: dgii.offline(), ultimoErrorRed: dgii.net.lastError,
    authError: queue.authError, lastRunAt: queue.lastRunAt
  };
}
