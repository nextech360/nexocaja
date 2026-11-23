-- NexoCaja 1.6.0 · Envío de e-CF a la DGII: resumen RFCE y reemisión de rechazados
ALTER TABLE ecf_documents ADD COLUMN rfce_path TEXT;
ALTER TABLE ecf_documents ADD COLUMN reemplazado_por TEXT;   -- e-NCF nuevo cuando un rechazado se reemite
CREATE INDEX IF NOT EXISTS ix_ecf_created ON ecf_documents(created_at);
