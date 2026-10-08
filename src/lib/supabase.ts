import Constants from 'expo-constants';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The Supabase URL + anon key live in app.json under `extra` (they are public
// anon credentials — the service-role key is NEVER bundled into a mobile app).
type Extra = { supabaseUrl?: string; supabaseAnonKey?: string };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

const url = extra.supabaseUrl || 'https://BLUEBELL_SUPABASE_REF_PLACEHOLDER.supabase.co';
const anonKey = extra.supabaseAnonKey || '';

if (!url || !anonKey) {
  // Surface a clear message in dev rather than a cryptic client error.
  // eslint-disable-next-line no-console
  console.warn('Supabase URL/anon key missing. Set extra.supabaseUrl/extra.supabaseAnonKey in app.json.');
}

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    // Keep the session so logins survive app restarts (supabase-js persists to
    // AsyncStorage when react-native is the platform).
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
