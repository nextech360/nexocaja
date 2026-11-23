-- NexoCaja 1.4.0 · Devoluciones con nota de crédito (B04) y datos para los formatos 607 / 608

CREATE TABLE IF NOT EXISTS credit_notes (
  id             TEXT PRIMARY KEY,
  folio          TEXT NOT NULL UNIQUE,          -- NC-000001
  sale_id        TEXT NOT NULL REFERENCES sales(id),
  ncf            TEXT UNIQUE,                   -- B04… (null si el negocio no emite NCF)
  ncf_modified   TEXT,                          -- NCF de la factura que se modifica
  ncf_expires_on TEXT,
  customer_name  TEXT,
  customer_doc   TEXT,
  reason         TEXT NOT NULL,
  refund_method  TEXT NOT NULL CHECK (refund_method IN ('efectivo','tarjeta','transferencia')),
  restock        INTEGER NOT NULL DEFAULT 1,
  itbis_applies  INTEGER NOT NULL DEFAULT 1,    -- 0 = emitida después de 30 días: no rebaja ITBIS
  subtotal       INTEGER NOT NULL,              -- sin ITBIS
  tax_total      INTEGER NOT NULL,
  total          INTEGER NOT NULL,              -- lo que se le devuelve al cliente
  cost_total     INTEGER NOT NULL DEFAULT 0,
  shift_id       TEXT REFERENCES cash_shifts(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  authorized_by  TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cn_sale ON credit_notes(sale_id);
CREATE INDEX IF NOT EXISTS idx_cn_created ON credit_notes(created_at);
CREATE INDEX IF NOT EXISTS idx_cn_shift ON credit_notes(shift_id);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id             TEXT PRIMARY KEY,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id),
  sale_line_id   TEXT NOT NULL REFERENCES sale_lines(id),
  product_id     TEXT REFERENCES products(id),
  name_snapshot  TEXT NOT NULL,
  qty            REAL NOT NULL,
  unit_price     INTEGER NOT NULL,
  tax_rate       INTEGER NOT NULL,
  tax            INTEGER NOT NULL,
  line_total     INTEGER NOT NULL,
  unit_cost      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cnl_note ON credit_note_lines(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_cnl_sale_line ON credit_note_lines(sale_line_id);

INSERT OR IGNORE INTO counters (name, value) VALUES ('folio_nc', 0);

-- Tipo de anulación del 608 (01–10) cuando se anula una venta con NCF
ALTER TABLE sales ADD COLUMN cancel_type TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_paid ON sales(paid_at);
