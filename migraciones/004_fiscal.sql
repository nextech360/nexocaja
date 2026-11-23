-- NexoCaja 1.3.0 · Comprobantes fiscales (NCF), emisor y clientes

-- Datos del cliente congelados en la venta (si luego cambia el cliente, la factura no cambia)
ALTER TABLE sales ADD COLUMN customer_name TEXT;
ALTER TABLE sales ADD COLUMN customer_doc TEXT;

-- Modo de comprobantes: ninguno | NCF (serie B). e-CF llegará en una versión posterior.
INSERT OR IGNORE INTO settings (key, value) VALUES ('fiscal_mode', 'ninguno');

CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_doc ON customers(doc_number) WHERE doc_number IS NOT NULL AND active = 1;
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_ncf_seq_type ON ncf_sequences(kind, type_code, active);
CREATE INDEX IF NOT EXISTS idx_sales_ncf ON sales(ncf);
