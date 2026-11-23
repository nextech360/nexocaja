// NexoCaja · Firma XMLDSig (enveloped, RSA-SHA256) para e-CF, RFCE, semilla, etc.
// Requisito: el XML de entrada ya está en forma canónica y NO trae declaración <?xml?>
// (lo genera xml.js). Así la canonicalización C14N 1.0 es el propio texto.
import crypto from 'node:crypto';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

function signedInfo(digest, withNs) {
  return `<SignedInfo${withNs ? ` xmlns="${DS}"` : ''}><CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${RSA_SHA256}"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="${ENVELOPED}"></Transform></Transforms>` +
    `<DigestMethod Algorithm="${SHA256}"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
}

/**
 * Firma el documento. xml: '<Raiz>…</Raiz>' canónico, sin espacios de nombres en la raíz.
 * Devuelve { xml (con declaración), signatureValue, codigoSeguridad, digest }.
 */
export function signXml(xml, key, certDer) {
  const m = /^<([A-Za-z][\w.-]*)>/.exec(xml);
  if (!m || !xml.endsWith(`</${m[1]}>`)) throw new Error('XML a firmar mal formado');
  const root = m[1];
  const digest = crypto.createHash('sha256').update(xml, 'utf8').digest('base64');
  const si = signedInfo(digest, true); // forma canónica de SignedInfo (hereda xmlns de <Signature>)
  const signatureValue = crypto.sign('sha256', Buffer.from(si, 'utf8'), key).toString('base64');
  const signature = `<Signature xmlns="${DS}">${signedInfo(digest, false)}<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${Buffer.from(certDer).toString('base64')}</X509Certificate></X509Data></KeyInfo></Signature>`;
  const signed = xml.slice(0, -(root.length + 3)) + signature + `</${root}>`;
  return { xml: '<?xml version="1.0" encoding="utf-8"?>' + signed, signatureValue, codigoSeguridad: signatureValue.slice(0, 6), digest };
}

/** Verifica una firma hecha por signXml (para pruebas y para revisar lo guardado). */
export function verifyOwn(signedXml) {
  const body = signedXml.replace(/^<\?xml[^>]*\?>/, '');
  const sm = /<Signature xmlns="[^"]+">([\s\S]*?)<\/Signature>/.exec(body);
  if (!sm) return false;
  const unsigned = body.replace(sm[0], '');
  const digest = crypto.createHash('sha256').update(unsigned, 'utf8').digest('base64');
  const dv = /<DigestValue>([^<]+)<\/DigestValue>/.exec(sm[1])[1];
  const sv = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(sm[1])[1];
  const cert = new crypto.X509Certificate(Buffer.from(/<X509Certificate>([^<]+)<\/X509Certificate>/.exec(sm[1])[1], 'base64'));
  return digest === dv && crypto.verify('sha256', Buffer.from(signedInfo(dv, true)), cert.publicKey, Buffer.from(sv, 'base64'));
}
