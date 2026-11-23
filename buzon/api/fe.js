// Buzón NexoCaja · Servicios del receptor electrónico (los llama la DGII o el suplidor):
//   POST /t/{RNC}/fe/recepcion/api/ecf            → guarda el e-CF y responde el Acuse de Recibo (ARECF) firmado
//   POST /t/{RNC}/fe/aprobacioncomercial/api/ecf  → guarda la Aprobación Comercial (ACECF) de un cliente
import { putJson, exists, tenant, onlyRnc, drStamp, json } from '../lib/store.js';
import { readP12 } from '../lib/p12.js';
import { signXml } from '../lib/firma.js';

const MAX = 512 * 1024;
const tag = (xml, t) => { const m = new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml); return m ? m[1].trim() : ''; };
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function readXml(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX) throw Object.assign(new Error('Archivo demasiado grande'), { status: 413 });
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    const f = fd.get('xml');
    if (!f) throw Object.assign(new Error('Falta el campo xml'), { status: 400 });
    const xml = typeof f === 'string' ? f : await f.text();
    return { xml, fileName: typeof f === 'string' ? '' : f.name || '' };
  }
  return { xml: await request.text(), fileName: '' };
}

function acuse(t, rncEmisor, rncComprador, encf, motivo) {
  const body = '<ARECF><DetalleAcusedeRecibo><Version>1.0</Version>' +
    `<RNCEmisor>${esc(rncEmisor)}</RNCEmisor><RNCComprador>${esc(rncComprador)}</RNCComprador><eNCF>${esc(encf)}</eNCF>` +
    `<Estado>${motivo ? 1 : 0}</Estado>` + (motivo ? `<CodigoMotivoNoRecibido>${motivo}</CodigoMotivoNoRecibido>` : '') +
    `<FechaHoraAcuseRecibo>${drStamp()}</FechaHoraAcuseRecibo></DetalleAcusedeRecibo></ARECF>`;
  const p = readP12(Buffer.from(t.p12, 'base64'), t.password);
  return signXml(body, p.key, p.certDer).xml;
}

export async function POST(request) {
  const u = new URL(request.url);
  const rnc = onlyRnc(u.searchParams.get('rnc'));
  const route = String(u.searchParams.get('path') || '').toLowerCase().replace(/\/+$/, '');
  const t = await tenant(rnc);
  if (!t || t.disabled) return json(404, { mensaje: 'Receptor no registrado en este buzón' });
  let xml, fileName;
  try { ({ xml, fileName } = await readXml(request)); } catch (e) { return json(e.status || 400, { mensaje: e.message }); }
  const now = new Date().toISOString();

  if (route === 'fe/recepcion/api/ecf') {
    const rncEmisor = tag(xml, 'RNCEmisor'), rncComprador = tag(xml, 'RNCComprador'), encf = tag(xml, 'eNCF');
    let motivo = 0; // 1 error de especificación · 2 error de firma digital · 3 envío duplicado · 4 RNC comprador no corresponde
    if (!/^<\?xml[^>]*\?>\s*<ECF[\s>]/.test(xml.trim()) && !/^<ECF[\s>]/.test(xml.trim())) motivo = 1;
    else if (!rncEmisor || !/^E\d{12}$/.test(encf)) motivo = 1;
    else if (!/<Signature[\s>][\s\S]*<SignatureValue>[^<]+<\/SignatureValue>/.test(xml)) motivo = 2;
    else if (rncComprador !== rnc) motivo = 4;
    const key = `${onlyRnc(rncEmisor) || 'x'}${encf || 'x'}`;
    if (!motivo && await exists(`seen/${rnc}/${key}`)) motivo = 3;
    const arecf = acuse(t, rncEmisor, rncComprador || rnc, encf, motivo);
    if (!motivo) {
      await putJson(`inbox/${rnc}/${Date.now()}-ecf-${key}.json`, { tipo: 'ecf', xml, fileName, arecf, recibido: now, rncEmisor, encf });
      await putJson(`seen/${rnc}/${key}`, { at: now });
    }
    return new Response(arecf, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' } });
  }

  if (route === 'fe/aprobacioncomercial/api/ecf') {
    if (!/<ACECF[\s>]/.test(xml) || !/<SignatureValue>/.test(xml)) return json(400, { mensaje: 'Aprobación comercial inválida' });
    const encf = tag(xml, 'eNCF'), rncComprador = tag(xml, 'RNCComprador');
    await putJson(`inbox/${rnc}/${Date.now()}-acecf-${onlyRnc(rncComprador) || 'x'}${encf || 'x'}.json`, { tipo: 'acecf', xml, fileName, recibido: now, encf, rncComprador });
    return json(200, { mensaje: 'Aprobación comercial recibida' });
  }
  return json(404, { mensaje: 'Servicio no encontrado' });
}

export async function GET(request) {
  const u = new URL(request.url);
  const rnc = onlyRnc(u.searchParams.get('rnc'));
  const t = await tenant(rnc);
  return json(t && !t.disabled ? 200 : 404, { servicio: 'Buzón e-CF NexoCaja', receptor: t && !t.disabled ? t.nombre : null });
}
