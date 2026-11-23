export function GET() {
  return new Response(JSON.stringify({ ok: true, servicio: 'Buzón e-CF NexoCaja', version: '1.0.0', hora: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
}
