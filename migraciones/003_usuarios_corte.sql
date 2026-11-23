-- NexoCaja 1.2.0 · Acceso con PIN, sesiones, corte de caja y anulaciones

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,           -- sha256 del token de la cookie (el token nunca se guarda)
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

ALTER TABLE sales ADD COLUMN cancelled_at TEXT;
ALTER TABLE cash_shifts ADD COLUMN notes TEXT;

-- Ventas hechas en 1.1.0 (antes de existir el corte) quedan sin turno; no afectan el primer corte.
CREATE INDEX IF NOT EXISTS idx_shifts_status ON cash_shifts(register_id, status);
CREATE INDEX IF NOT EXISTS idx_cashmov_shift ON cash_movements(shift_id);
