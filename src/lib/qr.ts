// QR payloads are JSON. Every printed card (student AND staff) carries the
// compact {sid,name}; a few legacy student cards also include class, and
// staff cards may carry staffId/role. One scanner handles both, but because
// the {sid,name} form is identical for students and staff the operator's
// active mode (modeHint) decides how an ambiguous payload is interpreted.
// A tolerant pipe form is also accepted, mirroring the web AttendanceTaker.
export type ScanTarget =
  | { kind: 'student'; sid?: string | number; name: string; class?: string; passport?: string | null; direction?: 'in' | 'out' }
  | { kind: 'staff'; staffId?: string; name: string; role?: string; passport?: string | null; direction?: 'in' | 'out' };

export function parseQrPayload(text: string, modeHint?: 'student' | 'staff'): ScanTarget | null {
  const raw = (text || '').trim();
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      // Explicit student card: carries a class.
      if (obj.name && obj.class) {
        return { kind: 'student', sid: obj.sid, name: String(obj.name), class: String(obj.class) };
      }
      // Explicit staff card: has staffId or role but no class.
      if (obj.staffId || obj.role) {
        return {
          kind: 'staff',
          staffId: obj.staffId ? String(obj.staffId) : undefined,
          name: String(obj.name || obj.staffId || 'Staff'),
          role: obj.role ? String(obj.role) : undefined,
        };
      }
      // Ambiguous {sid,name} — the form BOTH card types actually print. Use the
      // active mode to classify; class (if any) stays for a roster resolution.
      if (obj.name) {
        if (modeHint === 'staff') {
          const id = obj.staffId ?? obj.sid;
          return { kind: 'staff', staffId: id != null ? String(id) : undefined, name: String(obj.name) };
        }
        return {
          kind: 'student',
          sid: obj.sid,
          name: String(obj.name),
          class: obj.class != null ? String(obj.class) : undefined,
        };
      }
    }
  } catch {
    /* not JSON – fall back to the pipe form */
  }

  const parts = raw.split('|');
  if (parts.length >= 3) {
    return { kind: 'student', sid: parts[0], name: parts[1], class: parts.slice(2).join('|') };
  }
  if (parts.length === 2) {
    return modeHint === 'student'
      ? { kind: 'student', sid: parts[0], name: parts[1] }
      : { kind: 'staff', staffId: parts[0], name: parts[1] };
  }
  return null;
}
