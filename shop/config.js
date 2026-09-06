// Same Supabase project as the POS. The publishable key is public by design;
// the storefront can only read the shop_products / shop_settings views and
// call place_order(). It cannot read orders, costs or anything else.
export const CONFIG = {
  SUPABASE_URL: 'https://wtffisrmlgasjoqrfivc.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_vTLlIZkwuzqfRHMfcKzDbQ_gb7xPksM',
};
