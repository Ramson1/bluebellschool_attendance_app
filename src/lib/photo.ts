import { supabase } from './supabase';

// bluebell_student.passport stores a bare FILENAME in the public "passport" bucket
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

// Staff pics live in the "staff_passport" bucket with a fallback to the
// long-standing "passport" bucket (mirrors the admin StaffAccounts picUrl).
export function staffPhotoUrl(pic?: string | null): string | null {
  const p = String(pic ?? '').trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  try {
    return (
      supabase.storage.from('staff_passport').getPublicUrl(p).data.publicUrl ||
      supabase.storage.from('passport').getPublicUrl(p).data.publicUrl ||
      null
    );
  } catch {
    return null;
  }
}

// Resolve either photo kind to a display URL; used to attach the passport to
// scan results so gate staff can recognise the child face-to-face.
export function personPhotoUrl(passport?: string | null, kind: 'student' | 'staff' = 'student'): string | null {
  return kind === 'staff' ? staffPhotoUrl(passport) : studentPhotoUrl(passport);
}
