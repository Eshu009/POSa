// From Supabase -> Connect -> App Frameworks.
// The publishable key is meant to be public; Row Level Security in schema.sql is
// what actually guards the data (nothing is readable without logging in).
// Never put the service_role / secret key here — it bypasses every rule.
export const CONFIG = {
  SUPABASE_URL: 'https://wtffisrmlgasjoqrfivc.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_vTLlIZkwuzqfRHMfcKzDbQ_gb7xPksM',
};
