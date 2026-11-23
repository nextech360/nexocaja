-- NexoCaja 1.5.0 · Facturación electrónica (e-CF): certificado, documentos firmados y bitácora DGII

INSERT OR IGNORE INTO settings (key, value) VALUES ('ecf_ambiente', 'TesteCF');   -- TesteCF | CerteCF | eCF
INSERT OR IGNORE INTO settings (key, value) VALUES ('ecf_urls', '{}');

ALTER TABLE company ADD COLUMN email TEXT;
ALTER TABLE ncf_sequences ADD COLUMN ambiente TEXT;   -- solo secuencias E: TesteCF / CerteCF / eCF

CREATE TABLE IF NOT EXISTS ecf_certificates (
  id            TEXT PRIMARY KEY,
  file_name     TEXT NOT NULL,          -- dentro de datos/certs, cifrado con AES-256-GCM
  password_enc  TEXT NOT NULL,
  subject       TEXT,
  issuer        TEXT,
  serial        TEXT,
  doc_titular   TEXT,
  not_before    TEXT NOT NULL,
  not_after     TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  uploaded_by   TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ecf_documents (
  id               TEXT PRIMARY KEY,
  ambiente         TEXT NOT NULL,
  tipo             TEXT NOT NULL,
  encf             TEXT NOT NULL UNIQUE,
  origen           TEXT NOT NULL,             -- venta | nota_credito | nota_debito | compra | gasto | reemplazo
  origen_id        TEXT NOT NULL,
  ruta             TEXT NOT NULL,             -- ECF | RFCE
  rnc_comprador    TEXT,
  monto_total      INTEGER NOT NULL,
  itbis_total      INTEGER NOT NULL,
  fecha_emision    TEXT NOT NULL,             -- dd-MM-AAAA
  fecha_firma      TEXT,                      -- dd-MM-AAAA HH:mm:ss
  codigo_seguridad TEXT,
  vence_secuencia  TEXT,
  xml_path         TEXT,
  xml_sha256       TEXT,
  estado           TEXT NOT NULL,             -- generado | firmado | en_cola | enviado | en_proceso | aceptado | aceptado_condicional | rechazado | error_local
  track_id         TEXT,
  dgii_codigo      TEXT,
  dgii_mensajes    TEXT,
  enviado_at       TEXT,
  resuelto_at      TEXT,
  intentos         INTEGER NOT NULL DEFAULT 0,
  proximo_intento  TEXT,
  contingencia     INTEGER NOT NULL DEFAULT 0,
  limite_envio     TEXT,
  ref_encf         TEXT,
  ref_fecha        TEXT,
  ref_codigo       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ecf_estado ON ecf_documents(estado, proximo_intento);
CREATE INDEX IF NOT EXISTS ix_ecf_origen ON ecf_documents(origen, origen_id);

CREATE TABLE IF NOT EXISTS ecf_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     TEXT REFERENCES ecf_documents(id),
  ambiente        TEXT NOT NULL,
  servicio        TEXT NOT NULL,
  http_status     INTEGER,
  duracion_ms     INTEGER,
  request_resumen TEXT,
  response_raw    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ecf_log_doc ON ecf_log(document_id);
