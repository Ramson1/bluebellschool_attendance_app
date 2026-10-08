import { supabase } from './supabase';
import type { ScanTarget } from './qr';

// Sign-in / sign-out toggle logic — a faithful port of the web AttendanceTaker
// so a scan of someone already inside signs them out, and the mobile + web apps
// produce identical rows in jmis_attendance / jmis_staff_attendance.
const todayISO = () => new Date().toISOString().slice(0, 10);

export type Settings = { session: string; term: string };

export type ScanResult = {
  ok: boolean;
  action: 'in' | 'out' | 'again' | 'present' | 'unknown';
  name: string;
  message: string;
  error?: string;
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
  const { name, class: cls } = target;
  let sid = target.sid != null ? Number(target.sid) : undefined;
  if (Number.isNaN(sid)) sid = undefined;

  // Resolve the numeric student id when it wasn't in the payload.
  if (sid == null) {
    const { data: stu } = await supabase
      .from('jmis_student')
      .select('id')
      .eq('name', name)
      .eq('class', cls)
      .maybeSingle();
    sid = stu?.id ?? undefined;
  }

  const { data: existing, error: qErr } = await supabase
    .from('jmis_attendance')
    .select('id, check_out_time')
    .eq('student_name', name)
    .eq('class', cls)
    .eq('date', date)
    .maybeSingle();
  if (qErr) return { ok: false, action: 'unknown', name, message: '', error: qErr.message };

  if (existing && !existing.check_out_time) {
    const { error } = await supabase
      .from('jmis_attendance')
      .update({ check_out_time: new Date().toISOString(), sign_out_method: method })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'out', name, message: '', error: error.message };
    return { ok: true, action: 'out', name, message: `${name} signed out (${method})` };
  }

  if (existing) {
    const { error } = await supabase
      .from('jmis_attendance')
      .update({ check_in_time: new Date().toISOString(), method, check_out_time: null, sign_out_method: null })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'again', name, message: '', error: error.message };
    return { ok: true, action: 'again', name, message: `${name} signed in again (${method})` };
  }

  const { error } = await supabase.from('jmis_attendance').insert([
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
        .from('jmis_attendance')
        .select('id, check_out_time')
        .eq('student_name', name)
        .eq('class', cls)
        .eq('date', date)
        .maybeSingle();
      if (row && !row.check_out_time) {
        await supabase
          .from('jmis_attendance')
          .update({ check_out_time: new Date().toISOString(), sign_out_method: method })
          .eq('id', row.id);
        return { ok: true, action: 'out', name, message: `${name} signed out (${method})` };
      }
      return { ok: true, action: 'present', name, message: `${name} is already marked present today` };
    }
    return { ok: false, action: 'in', name, message: '', error: error.message };
  }
  return { ok: true, action: 'in', name, message: `${name} checked in (${method})` };
}

async function applyStaff(
  target: Extract<ScanTarget, { kind: 'staff' }>,
  method: 'qr' | 'manual',
  date: string,
): Promise<ScanResult> {
  const { name } = target;
  let staffId = target.staffId;

  // Resolve the staff uuid from the directory when the payload omitted it.
  if (!staffId) {
    const { data: stu } = await supabase
      .from('jmis_staff')
      .select('id')
      .ilike('name', name)
      .maybeSingle();
    staffId = stu?.id ?? undefined;
  }
  if (!staffId) {
    return { ok: false, action: 'unknown', name, message: '', error: `Staff "${name}" not found in the directory` };
  }

  const { data: existing, error: qErr } = await supabase
    .from('jmis_staff_attendance')
    .select('id, check_out_time')
    .eq('staff_id', staffId)
    .eq('date', date)
    .maybeSingle();
  if (qErr) return { ok: false, action: 'unknown', name, message: '', error: qErr.message };

  if (existing && !existing.check_out_time) {
    const { error } = await supabase
      .from('jmis_staff_attendance')
      .update({ check_out_time: new Date().toISOString(), sign_out_method: method })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'out', name, message: '', error: error.message };
    return { ok: true, action: 'out', name, message: `${name} signed out (${method})` };
  }

  if (existing) {
    const { error } = await supabase
      .from('jmis_staff_attendance')
      .update({ check_in_time: new Date().toISOString(), method, check_out_time: null, sign_out_method: null })
      .eq('id', existing.id);
    if (error) return { ok: false, action: 'again', name, message: '', error: error.message };
    return { ok: true, action: 'again', name, message: `${name} signed in again (${method})` };
  }

  const { error } = await supabase.from('jmis_staff_attendance').insert([
    { staff_id: staffId, staff_name: name, role: target.role || 'Staff', date, method },
  ]);
  if (error) {
    if (isDuplicate(error)) return { ok: true, action: 'present', name, message: `${name} is already marked present today` };
    return { ok: false, action: 'in', name, message: '', error: error.message };
  }
  return { ok: true, action: 'in', name, message: `${name} checked in (${method})` };
}

// Shared settings row (session + term) stamped onto new attendance records.
export async function fetchSettings(): Promise<Settings> {
  const { data } = await supabase.from('jmis_settings').select('session, term').limit(1);
  return { session: data?.[0]?.session || '', term: data?.[0]?.term || '' };
}
