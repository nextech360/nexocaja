// NexoCaja · Construcción del XML de los e-CF (formato DGII v1.0).
// El XML se genera YA en forma canónica (C14N 1.0): sin declaración en el cuerpo
// firmado, sin espacios entre etiquetas, sin etiquetas vacías y con los escapes de C14N.
// Así el hash que firmamos es exactamente el de lo que se guarda y se envía.
import { ECF_TYPES, IND_FACTURACION, FORMA_PAGO } from './catalogo.js';

/** Escape de texto según C14N. */
export function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}
/** Limpia texto libre: sin saltos de línea ni espacios repetidos, recortado al largo máximo. */
export function clean(v, max = 150) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Elemento; omite los vacíos (la DGII no acepta etiquetas vacías). */
export function el(name, content) {
  if (content == null || content === '' || (Array.isArray(content) && !content.filter(Boolean).length)) return '';
  const inner = Array.isArray(content) ? content.join('') : typeof content === 'string' && content.startsWith('<') ? content : esc(content);
  return `<${name}>${inner}</${name}>`;
}
const txt = (name, v, max) => { const c = clean(v, max); return c ? `<${name}>${esc(c)}</${name}>` : ''; }; // siempre texto escapado
export const money = (cents) => (Math.round(cents) / 100).toFixed(2);
export const ddmmyyyy = (d) => { const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd}-${m}-${y}`; };

/**
 * Arma el XML (sin firma) de un e-CF.
 * doc: { tipo, encf, venceSecuencia, indicadorNotaCredito, tipoPago, pagos[{metodo, monto}],
 *        emisor{rnc, razonSocial, nombreComercial, sucursal, direccion, telefono, correo}, fechaEmision 'AAAA-MM-DD',
 *        comprador{rnc, razonSocial}|null, lineas[{nombre, cantidad, precioIncl, descuentoPct, descuento, tasa, itbis, total}],
 *        referencia{ncf, fecha 'AAAA-MM-DD', codigo, razon}|null, fechaHoraFirma 'dd-MM-AAAA HH:mm:ss' }
 * Devuelve { xml, totales }.
 */
export function buildEcf(doc) {
  const t = ECF_TYPES[doc.tipo];
  if (!t) throw new Error(`Tipo de e-CF no soportado: ${doc.tipo}`);
  if (doc.lineas.length > 1000) throw new Error('Demasiadas líneas para un e-CF');

  // Montos SIN ITBIS (IndicadorMontoGravado = 0). Base de cada línea = total − ITBIS (exacto en centavos).
  const tot = { g1: 0, g2: 0, ex: 0, i1: 0, i2: 0, total: 0 };
  const items = doc.lineas.map((l, i) => {
    const rate = l.tasa;
    const ind = IND_FACTURACION[rate];
    if (!ind) throw new Error(`Tasa de ITBIS no soportada: ${rate}`);
    const base = l.total - l.itbis;
    const descBase = l.descuento ? Math.round((l.descuento * 100) / (100 + rate)) : 0;
    const qty = Math.round(l.cantidad * 100) / 100 || 0.01;
    const unit = ((base + descBase) / 100 / qty).toFixed(4);
    if (rate === 18) { tot.g1 += base; tot.i1 += l.itbis; } else if (rate === 16) { tot.g2 += base; tot.i2 += l.itbis; } else tot.ex += base;
    tot.total += l.total;
    return '<Item>' +
      el('NumeroLinea', i + 1) + el('IndicadorFacturacion', ind) + txt('NombreItem', l.nombre, 80) +
      el('IndicadorBienoServicio', l.servicio ? 2 : 1) + el('CantidadItem', qty.toFixed(2)) +
      el('PrecioUnitarioItem', unit) +
      (descBase ? el('DescuentoMonto', money(descBase)) +
        el('TablaSubDescuento', [el('SubDescuento', [el('TipoSubDescuento', '%'), el('SubDescuentoPorcentaje', Number(l.descuentoPct || 0).toFixed(2)), el('MontoSubDescuento', money(descBase))])]) : '') +
      el('MontoItem', money(base)) + '</Item>';
  });
  const gravado = tot.g1 + tot.g2;
  const itbis = tot.i1 + tot.i2;

  const pagos = (doc.pagos || []).filter((p) => p.monto > 0 && FORMA_PAGO[p.metodo]);
  const idDoc = [
    el('TipoeCF', doc.tipo), el('eNCF', doc.encf),
    t.venceSecuencia && doc.venceSecuencia ? el('FechaVencimientoSecuencia', ddmmyyyy(doc.venceSecuencia)) : '',
    doc.tipo === '34' ? el('IndicadorNotaCredito', doc.indicadorNotaCredito ? 1 : 0) : '',
    el('IndicadorMontoGravado', 0), el('TipoIngresos', '01'), el('TipoPago', doc.tipoPago || 1),
    doc.tipo !== '34' && pagos.length ? el('TablaFormasPago', pagos.map((p) => el('FormaDePago', [el('FormaPago', FORMA_PAGO[p.metodo]), el('MontoPago', money(p.monto))]))) : ''
  ];
  const e = doc.emisor;
  const emisor = [
    el('RNCEmisor', e.rnc), txt('RazonSocialEmisor', e.razonSocial, 150), txt('NombreComercial', e.nombreComercial, 150), txt('Sucursal', e.sucursal, 20),
    txt('DireccionEmisor', e.direccion, 100),
    /^\d{3}-\d{3}-\d{4}$/.test(e.telefono || '') ? el('TablaTelefonoEmisor', [el('TelefonoEmisor', e.telefono)]) : '',
    txt('CorreoEmisor', e.correo, 80), el('FechaEmision', ddmmyyyy(doc.fechaEmision))
  ];
  const c = doc.comprador;
  const comprador = c && (c.rnc || c.razonSocial) ? el('Comprador', [el('RNCComprador', c.rnc), txt('RazonSocialComprador', c.razonSocial, 150)]) : '';
  const totales = [
    gravado ? el('MontoGravadoTotal', money(gravado)) : '', tot.g1 ? el('MontoGravadoI1', money(tot.g1)) : '', tot.g2 ? el('MontoGravadoI2', money(tot.g2)) : '',
    tot.ex ? el('MontoExento', money(tot.ex)) : '',
    tot.g1 ? el('ITBIS1', 18) : '', tot.g2 ? el('ITBIS2', 16) : '',
    gravado ? el('TotalITBIS', money(itbis)) : '', tot.g1 ? el('TotalITBIS1', money(tot.i1)) : '', tot.g2 ? el('TotalITBIS2', money(tot.i2)) : '',
    el('MontoTotal', money(tot.total))
  ];
  const r = doc.referencia;
  const referencia = r ? el('InformacionReferencia', [el('NCFModificado', r.ncf), el('FechaNCFModificado', ddmmyyyy(r.fecha)), el('CodigoModificacion', r.codigo), txt('RazonModificacion', r.razon, 90)]) : '';

  const xml = '<ECF>' +
    el('Encabezado', [el('Version', '1.0'), el('IdDoc', idDoc), el('Emisor', emisor), comprador, el('Totales', totales)]) +
    el('DetallesItems', items) + referencia + el('FechaHoraFirma', doc.fechaHoraFirma) + '</ECF>';
  return { xml, totales: { gravado, exento: tot.ex, itbis, total: tot.total } };
}

/**
 * Resumen de Factura de Consumo Electrónica (RFCE) para E32 < RD$250,000, armado
 * a partir del e-CF ya firmado (mismos montos) + su código de seguridad.
 */
export function buildRfce(ecfXml, codigoSeguridad) {
  const get = (src, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(src); return m ? m[1] : null; };
  const raw = (tag, src = ecfXml) => { const v = get(src, tag); return v == null ? '' : `<${tag}>${v}</${tag}>`; };
  const totSrc = get(ecfXml, 'Totales') || '';
  const pagos = get(ecfXml, 'TablaFormasPago');
  const comp = get(ecfXml, 'Comprador');
  const totales = ['MontoGravadoTotal', 'MontoGravadoI1', 'MontoGravadoI2', 'MontoGravadoI3', 'MontoExento', 'TotalITBIS', 'TotalITBIS1', 'TotalITBIS2', 'TotalITBIS3', 'MontoTotal']
    .map((t) => raw(t, totSrc)).join('');
  return '<RFCE><Encabezado>' + el('Version', '1.0') +
    '<IdDoc>' + raw('TipoeCF') + raw('eNCF') + raw('TipoIngresos') + raw('TipoPago') + (pagos ? `<TablaFormasPago>${pagos}</TablaFormasPago>` : '') + '</IdDoc>' +
    '<Emisor>' + raw('RNCEmisor') + raw('RazonSocialEmisor') + raw('FechaEmision') + '</Emisor>' +
    (comp ? '<Comprador>' + raw('RNCComprador', comp) + raw('RazonSocialComprador', comp) + '</Comprador>' : '') +
    '<Totales>' + totales + '</Totales>' + el('CodigoSeguridadeCF', codigoSeguridad) + '</Encabezado></RFCE>';
}
