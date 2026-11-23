-- NexoCaja 1.1.0 · Caja, productos e inventario
-- Usuario temporal hasta que llegue el login (1.2.0): todas las ventas quedan a su nombre.
INSERT OR IGNORE INTO users (id, username, full_name, role_id) VALUES ('u-admin', 'admin', 'Administrador', 'owner');

INSERT OR IGNORE INTO departments (id, name) VALUES ('dep-general', 'General');

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('folio', 0);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status, created_at);
