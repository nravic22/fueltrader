import { createClient } from '@supabase/supabase-js';

// Server-only client (API routes). Uses the anon key since queries here are
// all read-only lookups meant to be safe for public/unauthenticated use —
// the service role key is reserved for the ingestion script only.
export function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.');
  }

  return createClient(url, anonKey);
}
