import { supabase } from './supabase';

// jmis_student.passport stores a bare FILENAME in the public "passport" bucket
// (matching the admin /full_student page). Build the public URL from it; handle
// legacy rows that already store a full URL. Returns null when there's nothing.
export function studentPhotoUrl(passport?: string | null): string | null {
  const p = String(passport ?? '').trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  try {
    return supabase.storage.from('passport').getPublicUrl(p).data.publicUrl || null;
  } catch {
    return null;
  }
}
