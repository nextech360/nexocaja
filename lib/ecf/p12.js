// NexoCaja · Lector de certificados PKCS#12 (.p12 / .pfx) sin dependencias.
// Node no lee .p12 y su OpenSSL 3 no trae RC2 (lo usan muchos .p12 "legacy"),
// así que aquí va: DER/BER, KDF de PKCS#12, PBES2 (AES/3DES), 3DES y RC2 en JS.
import crypto from 'node:crypto';

// ── DER / BER ─────────────────────────────────────────────────────
function readNode(buf, pos) {
  const start = pos;
  const b0 = buf[pos++];
  const cls = b0 >> 6, constructed = !!(b0 & 0x20);
  let tag = b0 & 0x1f;
  if (tag === 0x1f) { tag = 0; let b; do { b = buf[pos++]; tag = (tag << 7) | (b & 0x7f); } while (b & 0x80); }
  let len = buf[pos++];
  let indefinite = false;
  if (len === 0x80) indefinite = true;
  else if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new Error('ASN.1: longitud no soportada');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  const node = { cls, tag, constructed, start, contentStart: pos, children: null };
  if (indefinite) {
    if (!constructed) throw new Error('ASN.1: longitud indefinida en tipo primitivo');
    node.children = [];
    while (!(buf[pos] === 0 && buf[pos + 1] === 0)) { const c = readNode(buf, pos); node.children.push(c); pos = c.end; }
    node.contentEnd = pos; node.end = pos + 2;
  } else {
    node.contentEnd = pos + len; node.end = pos + len;
    if (node.end > buf.length) throw new Error('ASN.1: datos truncados');
    if (constructed) {
      node.children = [];
      let p = pos;
      while (p < node.contentEnd) { const c = readNode(buf, p); node.children.push(c); p = c.end; }
    }
  }
  node.buf = buf;
  return node;
}
const parse = (buf) => readNode(buf, 0);
/** Contenido de un nodo; si es OCTET STRING construido (BER) concatena los trozos. */
function bytes(n) {
  if (!n.constructed) return n.buf.subarray(n.contentStart, n.contentEnd);
  return Buffer.concat(n.children.map(bytes));
}
function oid(n) {
  const b = bytes(n);
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
}
function int(n) { let v = 0; for (const x of bytes(n)) v = v * 256 + x; return v; }
const explicit0 = (n) => n.children[0];

const OID = {
  data: '1.2.840.113549.1.7.1', encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1', shroudedKeyBag: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3',
  x509: '1.2.840.113549.1.9.22.1',
  pbe3des: '1.2.840.113549.1.12.1.3', pbe2des: '1.2.840.113549.1.12.1.4', pbeRc2_128: '1.2.840.113549.1.12.1.5', pbeRc2_40: '1.2.840.113549.1.12.1.6',
  pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12',
  sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3',
  hmacSha1: '1.2.840.113549.2.7', hmacSha256: '1.2.840.113549.2.9', hmacSha384: '1.2.840.113549.2.10', hmacSha512: '1.2.840.113549.2.11'
};
const PBES2_CIPHERS = {
  '2.16.840.1.101.3.4.1.2': ['aes-128-cbc', 16], '2.16.840.1.101.3.4.1.22': ['aes-192-cbc', 24], '2.16.840.1.101.3.4.1.42': ['aes-256-cbc', 32],
  '1.2.840.113549.3.7': ['des-ede3-cbc', 24]
};
const HASH_OF = { [OID.sha1]: 'sha1', [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512',
  [OID.hmacSha1]: 'sha1', [OID.hmacSha256]: 'sha256', [OID.hmacSha384]: 'sha384', [OID.hmacSha512]: 'sha512' };

// ── KDF de PKCS#12 (RFC 7292, apéndice B.2) ───────────────────────
function bmpPassword(pw) {
  const b = Buffer.alloc((pw.length + 1) * 2);
  for (let i = 0; i < pw.length; i++) b.writeUInt16BE(pw.charCodeAt(i), i * 2);
  return b;
}
function pkcs12Kdf(password, salt, id, iterations, n, hash = 'sha1') {
  const u = crypto.createHash(hash).digest().length;
  const v = hash === 'sha384' || hash === 'sha512' ? 128 : 64;
  const P0 = bmpPassword(password);
  const fill = (src) => { const len = src.length ? v * Math.ceil(src.length / v) : 0; const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = src[i % src.length]; return o; };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(P0)]);
  const out = [];
  let have = 0;
  while (have < n) {
    let A = crypto.createHash(hash).update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = crypto.createHash(hash).update(A).digest();
    out.push(A); have += A.length;
    if (have >= n) break;
    const B = Buffer.alloc(v); for (let i = 0; i < v; i++) B[i] = A[i % u];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const s = I[j + k] + B[k] + carry; I[j + k] = s & 0xff; carry = s >> 8; }
    }
  }
  return Buffer.concat(out).subarray(0, n);
}

// ── RC2 (RFC 2268), solo descifrado ───────────────────────────────
const PITABLE = Buffer.from(
  'd978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32' +
  'bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626' +
  '6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a' +
  '961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731' +
  '2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2e' +
  'c5f3db47e5a59c770aa62068fe7fc1ad', 'hex');
function rc2Keys(key, bits) {
  const L = Buffer.alloc(128);
  key.copy(L);
  const T = key.length;
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  const T8 = Math.ceil(bits / 8), TM = 0xff >> (8 * T8 - bits);
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}
function rc2DecryptCbc(data, key, iv, bits, raw = false) {
  if (data.length % 8) throw new Error('RC2: tamaño inválido');
  const K = rc2Keys(key, bits);
  const out = Buffer.alloc(data.length);
  const S = [1, 2, 3, 5];
  let prev = iv;
  for (let off = 0; off < data.length; off += 8) {
    const R = [data.readUInt16LE(off), data.readUInt16LE(off + 2), data.readUInt16LE(off + 4), data.readUInt16LE(off + 6)];
    let j = 63;
    const rmix = () => {
      for (let i = 3; i >= 0; i--) {
        R[i] = ((R[i] >>> S[i]) | (R[i] << (16 - S[i]))) & 0xffff;
        R[i] = (R[i] - K[j] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff;
        j--;
      }
    };
    const rmash = () => { for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
    for (let r = 0; r < 5; r++) rmix();
    rmash();
    for (let r = 0; r < 6; r++) rmix();
    rmash();
    for (let r = 0; r < 5; r++) rmix();
    for (let i = 0; i < 4; i++) out.writeUInt16LE(R[i], off + i * 2);
    for (let i = 0; i < 8; i++) out[off + i] ^= prev[i];
    prev = data.subarray(off, off + 8);
  }
  if (raw) return out;
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8) throw new Error('bad decrypt');
  for (let i = 1; i <= pad; i++) if (out[out.length - i] !== pad) throw new Error('bad decrypt');
  return out.subarray(0, out.length - pad);
}
export const _test = { rc2DecryptCbc, pkcs12Kdf };

// ── Descifrado según AlgorithmIdentifier ──────────────────────────
function decrypt(algNode, data, password) {
  const alg = oid(algNode.children[0]);
  const params = algNode.children[1];
  if (alg === OID.pbes2) {
    const kdf = params.children[0], scheme = params.children[1];
    if (oid(kdf.children[0]) !== OID.pbkdf2) throw new Error('KDF no soportado');
    const kp = kdf.children[1].children;
    const salt = bytes(kp[0]), iter = int(kp[1]);
    let prf = 'sha1';
    for (const extra of kp.slice(2)) if (extra.tag === 0x10) prf = HASH_OF[oid(extra.children[0])] || 'sha1';
    const c = PBES2_CIPHERS[oid(scheme.children[0])];
    if (!c) throw new Error('Cifrado no soportado en el .p12');
    const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, c[1], prf);
    const d = crypto.createDecipheriv(c[0], key, bytes(scheme.children[1]));
    return Buffer.concat([d.update(data), d.final()]);
  }
  const salt = bytes(params.children[0]), iter = int(params.children[1]);
  if (alg === OID.pbe3des || alg === OID.pbe2des) {
    let key = pkcs12Kdf(password, salt, 1, iter, 24);
    if (alg === OID.pbe2des) key = Buffer.concat([key.subarray(0, 16), key.subarray(0, 8)]);
    const iv = pkcs12Kdf(password, salt, 2, iter, 8);
    const d = crypto.createDecipheriv('des-ede3-cbc', key, iv);
    return Buffer.concat([d.update(data), d.final()]);
  }
  if (alg === OID.pbeRc2_40 || alg === OID.pbeRc2_128) {
    const bits = alg === OID.pbeRc2_40 ? 40 : 128;
    const key = pkcs12Kdf(password, salt, 1, iter, bits / 8);
    const iv = pkcs12Kdf(password, salt, 2, iter, 8);
    return rc2DecryptCbc(data, key, iv, bits);
  }
  throw new Error(`Algoritmo de cifrado no soportado (${alg})`);
}

export class P12Error extends Error {}

/**
 * Lee un .p12/.pfx. Devuelve { key (KeyObject), keyPem, cert (X509Certificate), certDer, chain[] }.
 * Lanza P12Error con mensaje en español si la contraseña es incorrecta o el archivo no sirve.
 */
export function readP12(fileBuf, password) {
  let pfx;
  try { pfx = parse(Buffer.from(fileBuf)); } catch { throw new P12Error('El archivo no es un certificado .p12 / .pfx válido'); }
  if (!pfx.children || pfx.children.length < 2) throw new P12Error('El archivo no es un certificado .p12 / .pfx válido');
  const authSafe = pfx.children[1];
  if (oid(authSafe.children[0]) !== OID.data) throw new P12Error('Certificado .p12 con formato no soportado (firmado con clave pública)');
  const authBytes = bytes(explicit0(authSafe.children[1]));

  // Verificación del MAC: detecta contraseña incorrecta antes de descifrar
  const macData = pfx.children[2];
  if (macData) {
    const digestInfo = macData.children[0];
    const hash = HASH_OF[oid(digestInfo.children[0].children[0])] || 'sha1';
    const expected = bytes(digestInfo.children[1]);
    const salt = bytes(macData.children[1]);
    const iter = macData.children[2] ? int(macData.children[2]) : 1;
    const ok = (pw) => {
      const mk = pkcs12Kdf(pw, salt, 3, iter, crypto.createHash(hash).digest().length, hash);
      return crypto.timingSafeEqual(crypto.createHmac(hash, mk).update(authBytes).digest(), expected);
    };
    if (!ok(password)) throw new P12Error('La contraseña del certificado es incorrecta');
  }

  const keys = [], certs = [];
  const readBags = (safeContentsDer) => {
    for (const bag of parse(safeContentsDer).children) {
      const id = oid(bag.children[0]);
      const val = explicit0(bag.children[1]);
      if (id === OID.shroudedKeyBag) keys.push(decrypt(val.children[0], bytes(val.children[1]), password));
      else if (id === OID.keyBag) keys.push(val.buf.subarray(val.start, val.end));
      else if (id === OID.certBag && oid(val.children[0]) === OID.x509) certs.push(Buffer.from(bytes(explicit0(val.children[1]))));
    }
  };
  try {
    for (const ci of parse(authBytes).children) {
      const type = oid(ci.children[0]);
      if (type === OID.data) readBags(bytes(explicit0(ci.children[1])));
      else if (type === OID.encryptedData) {
        const eci = explicit0(ci.children[1]).children[1];
        readBags(decrypt(eci.children[1], bytes(eci.children[2]), password));
      }
    }
  } catch (err) {
    if (err instanceof P12Error) throw err;
    throw new P12Error(/bad decrypt/i.test(err.message) ? 'La contraseña del certificado es incorrecta' : `No se pudo leer el certificado: ${err.message}`);
  }
  if (!keys.length) throw new P12Error('El .p12 no trae la clave privada (hace falta para firmar)');
  if (!certs.length) throw new P12Error('El .p12 no trae el certificado');
  const key = crypto.createPrivateKey({ key: Buffer.from(keys[0]), format: 'der', type: 'pkcs8' });
  const x509s = certs.map((d) => new crypto.X509Certificate(d));
  const idx = x509s.findIndex((c) => c.checkPrivateKey(key));
  if (idx < 0) throw new P12Error('La clave privada no corresponde a ningún certificado del archivo');
  return {
    key, keyPem: key.export({ type: 'pkcs8', format: 'pem' }),
    cert: x509s[idx], certDer: certs[idx], chain: x509s.filter((_, i) => i !== idx)
  };
}

/** Resumen legible del certificado. */
export function certInfo(cert) {
  const field = (dn, k) => { const m = new RegExp(`(?:^|\\n)${k}=([^\\n]+)`).exec(dn || ''); return m ? m[1].trim() : ''; };
  const serialNumber = field(cert.subject, 'serialNumber') || field(cert.subject, '2.5.4.5');
  return {
    name: field(cert.subject, 'CN'), organization: field(cert.subject, 'O'), issuer: field(cert.issuer, 'CN') || field(cert.issuer, 'O'),
    serial: cert.serialNumber, serialNumber, docTitular: (serialNumber.match(/\d{9,11}/) || [''])[0],
    notBefore: new Date(cert.validFrom).toISOString(), notAfter: new Date(cert.validTo).toISOString(), subject: cert.subject
  };
}
