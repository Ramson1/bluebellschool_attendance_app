import { supabase } from './supabase';

// Access control for the attendance app (requirement 12): the scanner is run at
// the front gate, so we allow developers, administrators, and non-academic
// staff whose designation is a security / gate role. This is a deliberate
// subset of "everyone who can open the web dashboard".
export const DEV_EMAILS = ['blackboxinfo01@gmail.com', 'rhemaexpertsolutions@gmail.com'];

// Substring-matched (case-insensitive) designations that qualify a non-academic
// staff member for gate duty. Kept in code (no schema change) per the plan.
const GATE_ROLE_HINTS = ['security', 'guard', 'gate', 'reception', 'front desk', 'attendant'];

const norm = (v: unknown): string => String(v ?? '').toLowerCase().trim();

export type Operator = {
  allowed: boolean;
  role: 'developer' | 'admin' | 'gate-staff' | 'none';
  email: string;
  staffId?: string;
  staffName?: string;
};

export async function resolveOperator(email: string | undefined | null): Promise<Operator> {
  const em = norm(email);
  if (!em) return { allowed: false, role: 'none', email: '' };

  const [{ data: devRows, error: devErr }, { data: adminRows, error: adminErr }] = await Promise.all([
    supabase.from('devauth').select('email'),
    supabase.from('bluebell_userauth').select('email'),
  ]);
  // A transport failure must not look like "not authorised" — the caller
  // (App.tsx) catches this and falls back to the locally cached operator.
  if (devErr || adminErr) throw new Error(`network: ${devErr?.message || adminErr?.message}`);
  const devEmails = [...DEV_EMAILS.map(norm), ...(devRows ?? []).map((r) => norm(r.email))];
  const adminEmails = (adminRows ?? []).map((r) => norm(r.email));

  if (devEmails.includes(em)) return { allowed: true, role: 'developer', email: em };
  if (adminEmails.includes(em)) return { allowed: true, role: 'admin', email: em };

  // Fall back to the staff directory: non-academic + a gate designation.
  const { data: staff, error: staffErr } = await supabase
    .from('bluebell_staff')
    .select('id, name, designation, department, status, email')
    .ilike('email', em)
    .maybeSingle();
  if (staffErr) throw new Error(`network: ${staffErr.message}`);

  if (staff && norm(staff.status) !== 'blocked') {
    const nonAcademic = norm(staff.department) === 'non-academic';
    const designation = norm(staff.designation);
    const isGate = GATE_ROLE_HINTS.some((h) => designation.includes(h));
    if (nonAcademic && isGate) {
      return {
        allowed: true,
        role: 'gate-staff',
        email: em,
        staffId: staff.id,
        staffName: staff.name,
      };
    }
  }

  return { allowed: false, role: 'none', email: em };
}
