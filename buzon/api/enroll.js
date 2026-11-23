// Buzón NexoCaja · Alta / actualización / baja de un negocio (la llama NexoCaja del dueño).
import crypto from 'node:crypto';
import { putJson, tenant, onlyRnc, sameSecret, sha256, json } from '../lib/store.js';
import { readP12 } from '../lib/p12.js';

function codes() { return String(process.env.NX_ENROLL_CODES || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 8); }
const validCode = (c) => codes().some((k) => k.length === String(c || '').length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(String(c))));
const base = (request) => { const u = new URL(request.url); return `${u.protocol}//${request.headers.get('x-forwarded-host') || u.host}`; };

export async function POST(request) {
  let b;
  try { b = await request.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  const rnc = onlyRnc(b.rnc);
  if (!rnc) return json(400, { error: 'RNC inválido' });
  const prev = await tenant(rnc);
  const apiKey = request.headers.get('x-api-key');
  const authorized = prev ? sameSecret(apiKey, prev.apiKeyHash) || validCode(b.code) : validCode(b.code);
  if (!authorized) return json(403, { error: prev ? 'Ese RNC ya está registrado: hace falta su clave o un código de activación nuevo' : 'Código de activación inválido' });
  let info;
  try {
    const p = readP12(Buffer.from(String(b.p12 || ''), 'base64'), String(b.password || ''));
    info = { notAfter: new Date(p.cert.validTo).toISOString(), subject: p.cert.subject.split('\n').find((l) => l.startsWith('CN=')) || '' };
    if (new Date(info.notAfter) < new Date()) return json(400, { error: 'El certificado está vencido' });
  } catch (e) { return json(400, { error: e.message || 'Certificado inválido' }); }
  const newKey = crypto.randomBytes(32).toString('base64url');
  await putJson(`tenants/${rnc}.json`, {
    rnc, nombre: String(b.razonSocial || '').slice(0, 150), p12: String(b.p12), password: String(b.password || ''),
    apiKeyHash: sha256(newKey), certVence: info.notAfter, certTitular: info.subject, creado: prev ? prev.creado : new Date().toISOString(), actualizado: new Date().toISOString()
  });
  const root = `${base(request)}/t/${rnc}`;
  return json(200, { apiKey: newKey, rnc, urls: { base: root, recepcion: `${root}/fe/recepcion/api/ecf`, aprobacion: `${root}/fe/aprobacioncomercial/api/ecf` }, certVence: info.notAfter });
}

export async function DELETE(request) {
  const rnc = onlyRnc(new URL(request.url).searchParams.get('rnc'));
  const t = await tenant(rnc);
  if (!t || !sameSecret(request.headers.get('x-api-key'), t.apiKeyHash)) return json(403, { error: 'No autorizado' });
  await putJson(`tenants/${rnc}.json`, { rnc, nombre: t.nombre, disabled: true, apiKeyHash: t.apiKeyHash, creado: t.creado, actualizado: new Date().toISOString() });
  return json(200, { ok: true, mensaje: 'Buzón desactivado y copia del certificado borrada' });
}
