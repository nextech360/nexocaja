# Buzón e-CF de NexoCaja

Servicio en Vercel que hace de **receptor electrónico** (DGII) para cada negocio que usa NexoCaja.
No forma parte de la instalación local (el actualizador lo ignora).

- `POST /t/{RNC}/fe/recepcion/api/ecf` — recibe un e-CF y responde el Acuse de Recibo (ARECF) firmado.
- `POST /t/{RNC}/fe/aprobacioncomercial/api/ecf` — recibe una Aprobación Comercial (ACECF).
- `POST /api/enroll` — NexoCaja da de alta el negocio (código de activación + certificado).
- `GET|POST /api/sync` — NexoCaja baja lo recibido y confirma.

Variables (solo en Vercel, nunca en el repo): `NX_MASTER_KEY`, `NX_ENROLL_CODES`, `BLOB_READ_WRITE_TOKEN`.
Todo se guarda cifrado con AES-256-GCM en un Blob privado. `lib/p12.js` y `lib/firma.js` son copia de `../lib/ecf/`.
