// QR payloads are JSON. Student ID cards carry {sid,name,class}; staff cards
// carry {staffId,name,role}. One scanner handles both by auto-detecting the
// shape. A tolerant pipe form (sid|name|class) is also accepted for legacy
// cards, mirroring the web AttendanceTaker parser.
export type ScanTarget =
  | { kind: 'student'; sid?: string | number; name: string; class: string }
  | { kind: 'staff'; staffId?: string; name: string; role?: string };

export function parseQrPayload(text: string): ScanTarget | null {
  const raw = (text || '').trim();
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      // Student card: has a class (and typically sid/name).
      if (obj.name && obj.class) {
        return { kind: 'student', sid: obj.sid, name: String(obj.name), class: String(obj.class) };
      }
      // Staff card: has staffId or role but no class.
      if (obj.staffId || obj.role) {
        return {
          kind: 'staff',
          staffId: obj.staffId ? String(obj.staffId) : undefined,
          name: String(obj.name || obj.staffId || 'Staff'),
          role: obj.role ? String(obj.role) : undefined,
        };
      }
      // A JSON object with a name but no discriminator → assume student-less
      // staff record; treat as staff with just a name.
      if (obj.name) {
        return { kind: 'staff', staffId: obj.sid ? String(obj.sid) : undefined, name: String(obj.name) };
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
    return { kind: 'staff', staffId: parts[0], name: parts[1] };
  }
  return null;
}
