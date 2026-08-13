const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn(
    '[supabase] SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. ' +
    'API routes that touch the database will fail until you set them.'
  );
}

const supabase = createClient(url || 'https://placeholder.supabase.co', key || 'placeholder', {
  auth: { persistSession: false },
});

module.exports = { supabase };
