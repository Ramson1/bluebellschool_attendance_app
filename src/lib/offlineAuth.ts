import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';
import { isOnline } from './offlineQueue';
import type { Operator } from './permissions';

// Offline sign-in support:
//  - The first sign-in for a given account must go through Supabase (online).
//  - On success we remember the credentials on the device, so the same email +
//    password can be verified locally when the gate has no internet.
//  - The resolved Operator is cached alongside, so the app knows what the user
//    is allowed to do without hitting the database.
//  - When connectivity returns, restoreSession() re-authenticates with
//    Supabase silently so queued scans can sync under the user's own session.
const CREDS_KEY = 'jmis_offline_creds_v1';
const OP_CACHE_KEY = 'jmis_operator_cache_v1';
const CURRENT_EMAIL_KEY = 'jmis_offline_current_email_v1';

const norm = (v: string): string => v.toLowerCase().trim();

// Minimal base64 codec (expo-crypto no longer ships one, and Hermes has no
// guaranteed atob/btoa). Only used to reversibly wrap the password for the
// silent re-auth described on StoredCred.pwBlob.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(str: string): string {
  const bytes = Array.from(str).map((c) => c.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b = [bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0];
    const n = (b[0] << 16) | (b[1] << 8) | b[2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const pad = bytes.length % 3;
  return pad ? out.slice(0, out.length - (3 - pad)) + '='.repeat(3 - pad) : out;
}

function b64decode(str: string): string {
  const clean = str.replace(/=+$/, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) || 0) << 6) |
      (B64.indexOf(clean[i + 3]) || 0);
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  return String.fromCharCode(...bytes.slice(0, Math.ceil((clean.length * 3) / 4)));
}

type StoredCred = {
  email: string;
  salt: string;
  pwHash: string;
  // Reversible encoding of the password (base64). It is kept so the app can
  // silently re-authenticate with Supabase once the device is back online;
  // the SHA-256 salted hash above is what gates local offline sign-in.
  pwBlob: string;
  savedAt: string;
};

async function hashPassword(salt: string, password: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${norm(password)}`);
}

async function loadCreds(): Promise<StoredCred[]> {
  try {
    const raw = await AsyncStorage.getItem(CREDS_KEY);
    return raw ? (JSON.parse(raw) as StoredCred[]) : [];
  } catch {
    return [];
  }
}

/** Remember a locally-verified account after a successful online sign-in. */
export async function rememberCredentials(email: string, password: string): Promise<void> {
  const em = norm(email);
  const salt = Crypto.randomUUID();
  const cred: StoredCred = {
    email: em,
    salt,
    pwHash: await hashPassword(salt, password),
    pwBlob: b64encode(password),
    savedAt: new Date().toISOString(),
  };
  const creds = (await loadCreds()).filter((c) => c.email !== em);
  creds.push(cred);
  await AsyncStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

/** Verify email + password against the copy saved on this device. */
export async function verifyCredentials(email: string, password: string): Promise<boolean> {
  const em = norm(email);
  const cred = (await loadCreds()).find((c) => c.email === em);
  if (!cred) return false;
  return (await hashPassword(cred.salt, password)) === cred.pwHash;
}

/** Email of the account currently signed in (used for silent re-auth). */
export async function setCurrentSignInEmail(email: string): Promise<void> {
  await AsyncStorage.setItem(CURRENT_EMAIL_KEY, norm(email));
}

export async function getCurrentSignInEmail(): Promise<string | null> {
  return (await AsyncStorage.getItem(CURRENT_EMAIL_KEY)) || null;
}

/**
 * If the device is online, a credential email was used for an offline sign-in,
 * and we still hold its saved password, sign in with Supabase silently so that
 * queued attendance syncs run under a real session. Returns true on success.
 */
export async function restoreSession(email: string): Promise<boolean> {
  if (!(await isOnline())) return false;
  const em = norm(email);
  const cred = (await loadCreds()).find((c) => c.email === em);
  if (!cred) return false;
  const { data } = await supabase.auth.getSession();
  if (data.session?.user?.email && norm(data.session.user.email) === em) return true;
  try {
    const password = b64decode(cred.pwBlob);
    const { error } = await supabase.auth.signInWithPassword({ email: em, password });
    return !error;
  } catch {
    return false;
  }
}

// ---- Operator cache -------------------------------------------------------
// Populated whenever resolveOperator() succeeds online; read as a fallback
// when the network is unavailable so offline sign-ins know the user's role.

type OpCache = Record<string, Operator>;

async function loadOpCache(): Promise<OpCache> {
  try {
    const raw = await AsyncStorage.getItem(OP_CACHE_KEY);
    return raw ? (JSON.parse(raw) as OpCache) : {};
  } catch {
    return {};
  }
}

export async function cacheOperator(op: Operator): Promise<void> {
  if (!op.email) return;
  const cache = await loadOpCache();
  cache[norm(op.email)] = op;
  await AsyncStorage.setItem(OP_CACHE_KEY, JSON.stringify(cache));
}

export async function getCachedOperator(email: string): Promise<Operator | null> {
  const cache = await loadOpCache();
  return cache[norm(email)] ?? null;
}
