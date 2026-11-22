-- NexoCaja · Esquema inicial (v1.0.0)
-- Montos en CENTAVOS (INTEGER). Fechas ISO-8601 (TEXT).
-- REGLA: las migraciones solo AGREGAN; nunca se edita una ya publicada.

CREATE TABLE company (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name    TEXT NOT NULL,
  trade_name    TEXT NOT NULL,
  rnc           TEXT,
  branch        TEXT,
  address       TEXT,
  phone         TEXT,
  tax_regime    TEXT NOT NULL DEFAULT 'ORDINARIO' CHECK (tax_regime IN ('ORDINARIO','RST')),
  cert_password_enc TEXT,           -- contraseña del .p12 cifrada con CERT_ENCRYPTION_KEY
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Usuarios y permisos ──────────────────────────────────────────
CREATE TABLE roles (
  id   TEXT PRIMARY KEY,               -- owner | supervisor | cashier
  name TEXT NOT NULL
);
INSERT INTO roles (id, name) VALUES ('owner','Dueño / Super administrador'), ('supervisor','Supervisor / Encargado'), ('cashier','Cajero');

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  role_id       TEXT NOT NULL REFERENCES roles(id),
  password_hash TEXT,
  pin_hash      TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT REFERENCES users(id),
  authorized_by TEXT REFERENCES users(id),
  action        TEXT NOT NULL,          -- login, venta.anular, nc.emitir, precio.modificar…
  entity        TEXT,
  entity_id     TEXT,
  detail        TEXT,                   -- JSON antes/después
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ── Catálogo e inventario ────────────────────────────────────────
CREATE TABLE departments (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,
  barcode         TEXT UNIQUE,
  name            TEXT NOT NULL,
  department_id   TEXT REFERENCES departments(id),
  unit            TEXT NOT NULL DEFAULT 'unidad',
  sell_by_weight  INTEGER NOT NULL DEFAULT 0,
  cost            INTEGER NOT NULL DEFAULT 0,
  price           INTEGER NOT NULL,          -- con ITBIS incluido
  wholesale_price INTEGER,
  wholesale_min_qty REAL,
  tax_rate        INTEGER NOT NULL DEFAULT 18 CHECK (tax_rate IN (0,16,18)),
  stock           REAL NOT NULL DEFAULT 0,
  min_stock       REAL NOT NULL DEFAULT 0,
  track_stock     INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_name ON products(name);

CREATE TABLE stock_movements (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  type       TEXT NOT NULL CHECK (type IN ('venta','devolucion','entrada','ajuste','merma','compra')),
  qty        REAL NOT NULL,
  ref_id     TEXT,
  user_id    TEXT REFERENCES users(id),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_stock_product ON stock_movements(product_id, created_at);

-- ── Clientes ─────────────────────────────────────────────────────
CREATE TABLE customers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  doc_type     TEXT CHECK (doc_type IN ('RNC','CEDULA')),
  doc_number   TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0,
  balance      INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_customers_doc ON customers(doc_number);

-- ── Comprobantes fiscales ────────────────────────────────────────
CREATE TABLE ncf_sequences (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('NCF','ECF')),
  type_code    TEXT NOT NULL,            -- 01,02… / 31,32…
  prefix       TEXT NOT NULL,            -- B01 / E31
  start_number INTEGER NOT NULL,
  end_number   INTEGER NOT NULL,
  next_number  INTEGER NOT NULL,
  expires_on   TEXT,
  alert_at_remaining INTEGER NOT NULL DEFAULT 50,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Caja ─────────────────────────────────────────────────────────
CREATE TABLE cash_shifts (
  id             TEXT PRIMARY KEY,
  register_id    TEXT NOT NULL,
  opened_by      TEXT NOT NULL REFERENCES users(id),
  opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
  opening_float  INTEGER NOT NULL DEFAULT 0,
  closed_by      TEXT REFERENCES users(id),
  closed_at      TEXT,
  expected_cash  INTEGER,
  counted_cash   INTEGER,
  status         TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','cerrada'))
);

CREATE TABLE cash_movements (
  id         TEXT PRIMARY KEY,
  shift_id   TEXT NOT NULL REFERENCES cash_shifts(id),
  type       TEXT NOT NULL CHECK (type IN ('entrada','salida')),
  amount     INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Ventas ───────────────────────────────────────────────────────
CREATE TABLE sales (
  id             TEXT PRIMARY KEY,
  folio          TEXT NOT NULL UNIQUE,
  ncf_type       TEXT,
  ncf            TEXT UNIQUE,
  ncf_expires_on TEXT,
  status         TEXT NOT NULL CHECK (status IN ('abierta','en_espera','pagada','anulada','devuelta')),
  customer_id    TEXT REFERENCES customers(id),
  shift_id       TEXT REFERENCES cash_shifts(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  subtotal       INTEGER NOT NULL DEFAULT 0,
  tax_total      INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  paid           INTEGER NOT NULL DEFAULT 0,
  change_given   INTEGER NOT NULL DEFAULT 0,
  cost_total     INTEGER NOT NULL DEFAULT 0,
  ecf_status     TEXT,                   -- pendiente | aceptado | aceptado_condicional | rechazado
  ecf_track_id   TEXT,
  cancel_reason  TEXT,
  cancelled_by   TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at        TEXT
);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_shift ON sales(shift_id);

CREATE TABLE sale_lines (
  id            TEXT PRIMARY KEY,
  sale_id       TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    TEXT REFERENCES products(id),
  name_snapshot TEXT NOT NULL,
  qty           REAL NOT NULL,
  unit_price    INTEGER NOT NULL,
  price_type    TEXT NOT NULL DEFAULT 'normal' CHECK (price_type IN ('normal','mayoreo','manual')),
  discount_pct  REAL NOT NULL DEFAULT 0,
  discount      INTEGER NOT NULL DEFAULT 0,
  tax_rate      INTEGER NOT NULL,
  tax           INTEGER NOT NULL,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL
);
CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);

CREATE TABLE sale_payments (
  id        TEXT PRIMARY KEY,
  sale_id   TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method    TEXT NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia','credito')),
  amount    INTEGER NOT NULL,
  received  INTEGER,
  reference TEXT
);

INSERT INTO settings (key, value) VALUES ('installed_at', datetime('now'));
