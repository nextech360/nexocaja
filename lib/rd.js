// Reglas fiscales de República Dominicana usadas por NexoCaja.

/** Tipos de comprobante. `sale: true` = se elige en la caja; B04 solo sale de una devolución. */
export const NCF_TYPES = {
  '02': { name: 'Consumo', short: 'Consumo', needsDoc: false, sale: true },
  '01': { name: 'Crédito Fiscal', short: 'Crédito Fiscal', needsDoc: true, sale: true },
  '15': { name: 'Gubernamental', short: 'Gubernamental', needsDoc: true, sale: true },
  '04': { name: 'Nota de Crédito', short: 'Nota de Crédito', needsDoc: false, sale: false }
};

/** Después de estos días, la nota de crédito ya no rebaja el ITBIS (se emite sin ITBIS). */
export const NC_ITBIS_DAYS = 30;

/** Tipos de anulación del Formato 608 (DGII). */
export const CANCEL_TYPES = {
  '01': 'Deterioro de factura pre-impresa',
  '02': 'Errores de impresión (factura pre-impresa)',
  '03': 'Impresión defectuosa',
  '04': 'Corrección de la información',
  '05': 'Cambio de productos',
  '06': 'Devolución de productos',
  '07': 'Omisión de productos',
  '08': 'Errores en secuencias de NCF',
  '09': 'Por cese de operaciones',
  '10': 'Pérdida o hurto de talonarios'
};
/** A partir de este monto (centavos) la factura de consumo debe identificar al comprador. */
export const CONSUMO_ID_THRESHOLD = 250000_00;

export const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

/** RNC: 9 dígitos, módulo 11 con pesos 7-9-8-6-5-4-3-2. */
export function validRnc(v) {
  const n = onlyDigits(v);
  if (n.length !== 9) return false;
  const w = [7, 9, 8, 6, 5, 4, 3, 2];
  const sum = w.reduce((s, x, i) => s + x * +n[i], 0);
  return String(((10 - (sum % 11)) % 9) + 1) === n[8];
}

/** Cédula: 11 dígitos, Luhn. */
export function validCedula(v) {
  const n = onlyDigits(v);
  if (n.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let d = +n[10 - i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Detecta y valida un documento. Devuelve { type, number, valid } o null si el largo no corresponde. */
export function parseDoc(v) {
  const n = onlyDigits(v);
  if (n.length === 9) return { type: 'RNC', number: n, valid: validRnc(n) };
  if (n.length === 11) return { type: 'CEDULA', number: n, valid: validCedula(n) };
  return null;
}

export function formatDoc(type, n) {
  n = onlyDigits(n);
  if (type === 'RNC' && n.length === 9) return `${n.slice(0, 1)}-${n.slice(1, 3)}-${n.slice(3, 8)}-${n.slice(8)}`;
  if (type === 'CEDULA' && n.length === 11) return `${n.slice(0, 3)}-${n.slice(3, 10)}-${n.slice(10)}`;
  return n;
}

/** NCF tradicional: B + tipo (2) + secuencia (8) = 11 caracteres. e-NCF: E + tipo (2) + secuencia (10) = 13. */
export function formatNcf(kind, type, seq) {
  return kind === 'ECF' ? `E${type}${String(seq).padStart(10, '0')}` : `B${type}${String(seq).padStart(8, '0')}`;
}
export const MAX_SEQ = { NCF: 99999999, ECF: 9999999999 };
