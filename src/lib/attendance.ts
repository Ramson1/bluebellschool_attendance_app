import { supabase } from './supabase';
import type { ScanTarget } from './qr';
import { studentPhotoUrl, staffPhotoUrl } from './photo';

// Sign-in / sign-out toggle logic — a faithful port of the web AttendanceTaker
// so a scan of someone already inside signs them out, and the mobile + web apps
// produce identical rows in bluebell_attendance / bluebell_staff_attendance.
const todayISO = () => new Date().toISOString().slice(0, 10);

export type Settings = { session: string; term: string };

export type ScanResult = {
  ok: boolean;
  action: 'in' | 'out' | 'again' | 'present' | 'unknown';
  name: string;
  message: string;
  error?: string;
  // Public passport URL for the scanned person (when on record) so the result
  // row can show a thumbnail / full-screen photo for face-to-face recognition.
  passport?: string | null;
};

const isDuplicate = (e: any) => e?.code === '23505' || /duplicate/i.test(e?.message || '');

export async function applyScan(
  target: ScanTarget,
  method: 'qr' | 'manual',
  settings: Settings,
): Promise<ScanResult> {
  const date = todayISO();
  return target.kind === 'student'
    ? applyStudent(target, method, settings, date)
    : applyStaff(target, method, date);
}

async function applyStudent(
  target: Extract<ScanTarget, { kind: 'student' }>,
  method: 'qr' | 'manual',
  settings: Settings,
  date: string,
): Promise<ScanResult> {
  let name = target.name;
  let cls = target.class;
  let sid = target.sid != null ? Number(target.sid) : undefined;
  if (Number.isNaN(sid)) sid = undefined;
  // Attendance type picked by the operator on screen: a scan can only do
  // the selected action, never flip the other way.
  const dir = target.direction ?? 'in';
  // Passport picked up from the roster lookup below (the QR payload itself never
  // carries a photo), so the success result can show the child's picture.
  let photo: string | null = null;

  // Printed cards carry only {sid,name}, so the class (and a missing id/name)
  // is resolved from the roster before the attendance lookups/insert below —
  // they all key on (student_name, class) and class cannot be left undefined.
  if (sid != null && !cls) {
    const { data: stu } = await supabase
      .from('bluebell_student')
      .select('name, class, passport')
      .eq('id', sid)
      .maybeSingle();
    if (!stu) {
      return { ok: false, action: 'unknown', name, message: '', error: `Student id ${sid} is not in the roster` };
    }
    name = stu.name;
    cls = stu.class;
    photo = studentPhotoUrl(stu.passport);
  } else if (sid == null) {
    const base = supabase.from('bluebell_student').select('id, name, class, passport').eq('name', name);
    const { data: stu } = cls ? await base.eq('class', cls).maybeSingle() : await base.maybeSingle();
    if (!stu) {
      return { ok: false, action: 'unknown', name, message: '', error: `Student "${name}" is not in the roster` };
    }
    sid = stu.id;
    cls = stu.class;
    photo = studentPhotoUrl(stu.passport);
  }

  // Cards that already carry a class skip both roster branches above, so make
  // one cheap id lookup purely for the passport photo.
  if (!photo && sid != null) {
    const { data: pic } = await supabase.from('bluebell_student').select('passport').eq('id', sid).maybeSingle();
    photo = studentPhotoUrl(pic?.passport);
  }

  const { data: existing, error: qErr } = await supabase
    .from('bluebell_attendance')
    .select('id, check_out_time')
    .eq('student_name', name)
    .eq('class', cls)
    .eq('date', date)
    .maybeSingle();
  if (qErr) return { ok: false, action: 'unknown', name, message: '', error: qErr.message };

  if (existing && !existing.check_out_time) {
    if (dir === 'in') {
      // Already inside: check-in mode must not sign the student back out.
      return { ok: true, action: 'present', name, message: `${name} is already checked in`, passport: photo };
    }
    const { error } = await supabase
      .from('bluebell_attendance')
      .update({ check_out_time: new Date().toISOString(), sign_out_method: method })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'out', name, message: '', error: error.message };
    return { ok: true, action: 'out', name, message: `${name} signed out (${method})`, passport: photo };
  }

  if (existing) {
    if (dir === 'out') {
      return { ok: false, action: 'out', name, message: '', error: `${name} already signed out — nothing to check out` };
    }
    const { error } = await supabase
      .from('bluebell_attendance')
      .update({ check_in_time: new Date().toISOString(), method, check_out_time: null, sign_out_method: null })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'again', name, message: '', error: error.message };
    return { ok: true, action: 'again', name, message: `${name} signed in again (${method})`, passport: photo };
  }

  if (dir === 'out') {
    return { ok: false, action: 'out', name, message: '', error: `${name} was not checked in today — cannot check out` };
  }
  const { error } = await supabase.from('bluebell_attendance').insert([
    {
      student_id: sid ?? null,
      student_name: name,
      class: cls,
      date,
      session: settings.session || null,
      term: settings.term || null,
      method,
    },
  ]);
  if (error) {
    if (isDuplicate(error)) {
      // Race with a web sign-in: re-read and sign that row out instead.
      const { data: row } = await supabase
        .from('bluebell_attendance')
        .select('id, check_out_time')
        .eq('student_name', name)
        .eq('class', cls)
        .eq('date', date)
        .maybeSingle();
      if (row && !row.check_out_time) {
        if (dir === 'in') {
          return { ok: true, action: 'present', name, message: `${name} is already checked in`, passport: photo };
        }
        await supabase
          .from('bluebell_attendance')
          .update({ check_out_time: new Date().toISOString(), sign_out_method: method })
          .eq('id', row.id);
        return { ok: true, action: 'out', name, message: `${name} signed out (${method})`, passport: photo };
      }
      return { ok: true, action: 'present', name, message: `${name} is already marked present today`, passport: photo };
    }
    return { ok: false, action: 'in', name, message: '', error: error.message };
  }
  return { ok: true, action: 'in', name, message: `${name} checked in (${method})`, passport: photo };
}

async function applyStaff(
  target: Extract<ScanTarget, { kind: 'staff' }>,
  method: 'qr' | 'manual',
  date: string,
): Promise<ScanResult> {
  const { name } = target;
  let staffId = target.staffId;
  // Attendance type picked by the operator (see applyStudent).
  const dir = target.direction ?? 'in';
  // Staff pics live on bluebell_staff.profile_pic; grab them with the uuid lookup
  // (or a dedicated one) so the success result can show the face.
  let photo: string | null = null;

  // Resolve the staff uuid from the directory when the payload omitted it.
  if (!staffId) {
    const { data: stu } = await supabase
      .from('bluebell_staff')
      .select('id, profile_pic')
      .ilike('name', name)
      .maybeSingle();
    staffId = stu?.id ?? undefined;
    photo = staffPhotoUrl(stu?.profile_pic);
  } else {
    const { data: pic } = await supabase.from('bluebell_staff').select('profile_pic').eq('id', staffId).maybeSingle();
    photo = staffPhotoUrl(pic?.profile_pic);
  }
  if (!staffId) {
    return { ok: false, action: 'unknown', name, message: '', error: `Staff "${name}" not found in the directory` };
  }

  const { data: existing, error: qErr } = await supabase
    .from('bluebell_staff_attendance')
    .select('id, check_out_time')
    .eq('staff_id', staffId)
    .eq('date', date)
    .maybeSingle();
  if (qErr) return { ok: false, action: 'unknown', name, message: '', error: qErr.message };

  if (existing && !existing.check_out_time) {
    if (dir === 'in') {
      // Already inside: check-in mode must not sign the staff member back out.
      return { ok: true, action: 'present', name, message: `${name} is already checked in`, passport: photo };
    }
    const { error } = await supabase
      .from('bluebell_staff_attendance')
      .update({ check_out_time: new Date().toISOString(), sign_out_method: method })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'out', name, message: '', error: error.message };
    return { ok: true, action: 'out', name, message: `${name} signed out (${method})`, passport: photo };
  }

  if (existing) {
    if (dir === 'out') {
      return { ok: false, action: 'out', name, message: '', error: `${name} already signed out — nothing to check out` };
    }
    const { error } = await supabase
      .from('bluebell_staff_attendance')
      .update({ check_in_time: new Date().toISOString(), method, check_out_time: null, sign_out_method: null })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'again', name, message: '', error: error.message };
    return { ok: true, action: 'again', name, message: `${name} signed in again (${method})`, passport: photo };
  }

  if (dir === 'out') {
    return { ok: false, action: 'out', name, message: '', error: `${name} was not checked in today — cannot check out` };
  }
  const { error } = await supabase.from('bluebell_staff_attendance').insert([
    { staff_id: staffId, staff_name: name, role: target.role || 'Staff', date, method },
  ]);
  if (error) {
    if (isDuplicate(error)) return { ok: true, action: 'present', name, message: `${name} is already marked present today`, passport: photo };
    return { ok: false, action: 'in', name, message: '', error: error.message };
  }
  return { ok: true, action: 'in', name, message: `${name} checked in (${method})`, passport: photo };
}

// Shared settings row (session + term) stamped onto new attendance records.
export async function fetchSettings(): Promise<Settings> {
  const { data } = await supabase.from('bluebell_settings').select('session, term').limit(1);
  return { session: data?.[0]?.session || '', term: data?.[0]?.term || '' };
}
