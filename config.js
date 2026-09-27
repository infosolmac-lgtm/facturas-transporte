// Configuración pública del proyecto (no contiene secretos).
// La publishable key es pública por diseño: la seguridad la aplica RLS en Supabase.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://lznrixazqfnnsxmcscpn.supabase.co',
  SUPABASE_KEY: 'sb_publishable_Da2FnagzCkVXJ-0UOD7qwQ_IEq-3QSJ',
  BUCKET: 'facturas',
  ALERT_DAYS: 7,        // días de antelación para avisos de vencimiento
  VERSION: '1.0.0'
};
