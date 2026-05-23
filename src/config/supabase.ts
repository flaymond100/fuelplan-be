import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing required env vars: SUPABASE_URL, SUPABASE_ANON_KEY');
}

// Public client — respects RLS
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

// Service client — bypasses RLS, used for webhook writes and server-side ops
const supabaseService: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey || supabaseAnonKey,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export { supabase, supabaseService };
