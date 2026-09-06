// Copy this file to config.js and fill in your own values.
// From Supabase -> Connect -> App Frameworks.
//
// The publishable / anon key is meant to be public; Row Level Security in
// schema.sql is what actually guards the data. Never put the service_role /
// secret key here — it bypasses every rule.
export const CONFIG = {
  SUPABASE_URL: 'PASTE_YOUR_PROJECT_URL_HERE',
  SUPABASE_ANON_KEY: 'PASTE_YOUR_ANON_OR_PUBLISHABLE_KEY_HERE',
};
