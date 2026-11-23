-- NexoCaja 1.7.0 · Buzón e-CF: facturas electrónicas recibidas de suplidores y aprobaciones comerciales
INSERT OR IGNORE INTO settings (key, value) VALUES ('buzon', '{}');

CREATE TABLE IF NOT EXISTS ecf_recibidos (
  id            TEXT PRIMARY KEY,
  rnc_emisor    TEXT NOT NULL,
  razon_social  TEXT,
  encf          TEXT NOT NULL,
  tipo          TEXT,
  fecha_emision TEXT,
  monto_total   INTEGER,
  itbis_total   INTEGER,
  xml_path      TEXT NOT NULL,
  arecf_path    TEXT,
  acuse_estado  TEXT,                    -- recibido | no_recibido
  aprobacion    TEXT NOT NULL DEFAULT 'pendiente',
  recibido_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (rnc_emisor, encf)
);
CREATE INDEX IF NOT EXISTS ix_recibidos_fecha ON ecf_recibidos(recibido_at);

ALTER TABLE ecf_documents ADD COLUMN aprobacion_comercial TEXT;   -- aprobado | rechazado (lo que respondió el cliente)
ALTER TABLE ecf_documents ADD COLUMN aprobacion_detalle TEXT;
