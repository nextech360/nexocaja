// NexoCaja · Catálogo de comprobantes fiscales electrónicos (e-CF) de la DGII.
// Fuente: Formato Comprobante Fiscal Electrónico (e-CF) v1.0.

export const ECF_TYPES = {
  '31': { name: 'Factura de Crédito Fiscal Electrónica', short: 'Crédito Fiscal', needsDoc: true, venceSecuencia: true, sale: true },
  '32': { name: 'Factura de Consumo Electrónica', short: 'Consumo', needsDoc: false, venceSecuencia: false, sale: true },
  '33': { name: 'Nota de Débito Electrónica', short: 'Nota de Débito', needsDoc: false, venceSecuencia: true, sale: false },
  '34': { name: 'Nota de Crédito Electrónica', short: 'Nota de Crédito', needsDoc: false, venceSecuencia: false, sale: false },
  '41': { name: 'Comprobante Electrónico de Compras', short: 'Compras', needsDoc: false, venceSecuencia: true, sale: false },
  '43': { name: 'Comprobante Electrónico para Gastos Menores', short: 'Gastos Menores', needsDoc: false, venceSecuencia: true, sale: false },
  '44': { name: 'Comprobante Electrónico para Regímenes Especiales', short: 'Regímenes Especiales', needsDoc: true, venceSecuencia: true, sale: true, exento: true },
  '45': { name: 'Comprobante Electrónico Gubernamental', short: 'Gubernamental', needsDoc: true, venceSecuencia: true, sale: true },
  '46': { name: 'Comprobante Electrónico para Exportaciones', short: 'Exportaciones', needsDoc: true, venceSecuencia: true, sale: false },
  '47': { name: 'Comprobante Electrónico para Pagos al Exterior', short: 'Pagos al Exterior', needsDoc: false, venceSecuencia: true, sale: false }
};

/** Tipos que se eligen en la caja, en el orden de los botones. */
export const ECF_SALE_ORDER = ['32', '31', '45', '44'];

/** IndicadorFacturacion por tasa de ITBIS. */
export const IND_FACTURACION = { 18: 1, 16: 2, 0: 4 }; // 0% en NexoCaja = exento (código 4)

/** FormaPago DGII. */
export const FORMA_PAGO = { efectivo: 1, transferencia: 2, tarjeta: 3, credito: 4 };

/** CodigoModificacion de InformacionReferencia. */
export const COD_MODIFICACION = { anula: 1, corrigeTexto: 2, corrigeMontos: 3, reemplazoContingencia: 4 };

export const AMBIENTES = {
  TesteCF: { name: 'Pruebas (TesteCF)', qr: 'testecf' },
  CerteCF: { name: 'Certificación (CerteCF)', qr: 'certecf' },
  eCF: { name: 'Producción (eCF)', qr: 'ecf' }
};

/** Leyenda obligatoria de la representación impresa en contingencia. */
export const LEYENDA_CONTINGENCIA = 'e-CF emitido en modalidad de Contingencia, el cual podrá ser consultado para su validez fiscal, a partir de las setenta y dos (72) horas.';
