import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { isOnline } from '../lib/offlineQueue';
import {
  rememberCredentials,
  verifyCredentials,
  setCurrentSignInEmail,
  getCachedOperator,
} from '../lib/offlineAuth';
import type { Operator } from '../lib/permissions';

// Front-gate sign-in. Only emails that pass resolveOperator() (developer,
// admin, or non-academic gate/security staff) are let through — enforced in
// App.tsx after the Supabase session is established.
//
// Offline logins: the first successful online sign-in for an account is
// remembered on the device, so the same credentials can be verified locally
// when there is no internet. New/unknown credentials while offline trigger a
// custom alert asking the user to connect to the internet first.
export default function LoginScreen({
  onOfflineSignIn,
}: {
  onOfflineSignIn: (operator: Operator) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [alertTitle, setAlertTitle] = useState('');
  const [alertBody, setAlertBody] = useState('');

  const customAlert = (title: string, body: string) => {
    setBusy(false);
    setAlertTitle(title);
    setAlertBody(body);
  };

  // No internet (or an unknown account offline): verify against the
  // credentials saved on this device from a previous online login.
  const offlineLogin = async () => {
    const known = await verifyCredentials(email, password);
    if (known) {
      const op = await getCachedOperator(email);
      if (op && op.allowed) {
        await setCurrentSignInEmail(email);
        setBusy(false);
        onOfflineSignIn(op);
        return;
      }
    }
    customAlert(
      'Internet required',
      "These login details are not saved on this device, so we can't verify them offline. Please connect this device to the internet and sign in once — after that you will be able to sign in offline.",
    );
  };

  const signIn = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError('');

    if (!(await isOnline())) {
      await offlineLogin();
      return;
    }

    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (!err) {
      // Success: remember this account on the device for future offline logins.
      await rememberCredentials(email, password);
      await setCurrentSignInEmail(email);
      setBusy(false);
      return; // App.tsx picks up the session and evaluates the operator role
    }
    if (/network|failed to fetch|timeout/i.test(err.message || '')) {
      // Connectivity dropped mid-request — fall back to local verification.
      await offlineLogin();
      return;
    }
    setBusy(false);
    setError(err.message || 'Invalid email or password');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.wrap}
    >
      <View style={styles.card}>
        <Text style={styles.brand}>BluebellSchool</Text>
        <Text style={styles.title}>Attendance Scanner</Text>
        <Text style={styles.subtitle}>Sign in to check students and staff in or out at the gate.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#8a93a2"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <View style={styles.pwWrap}>
          <TextInput
            style={[styles.input, styles.pwInput]}
            placeholder="Password"
            placeholderTextColor="#8a93a2"
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={signIn}
          />
          <TouchableOpacity
            style={styles.pwToggle}
            onPress={() => setShowPassword((s) => !s)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.pwToggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={styles.button} onPress={signIn} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </TouchableOpacity>
      </View>

      {/* custom alert — used for the "connect to the internet to verify new
          credentials" case and any other blocking notice */}
      <Modal visible={!!alertBody} transparent animationType="fade" onRequestClose={() => setAlertBody('')}>
        <View style={styles.alertBackdrop}>
          <View style={styles.alertCard}>
            <Text style={styles.alertTitle}>{alertTitle}</Text>
            <Text style={styles.alertBody}>{alertBody}</Text>
            <TouchableOpacity style={styles.alertBtn} onPress={() => setAlertBody('')}>
              <Text style={styles.alertBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#011b97', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 24, elevation: 8, shadowOpacity: 0.2, shadowRadius: 16 },
  brand: { color: '#022aa1', fontWeight: '700', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  title: { fontSize: 24, fontWeight: '800', color: '#011b97', marginTop: 2 },
  subtitle: { fontSize: 14, color: '#6b7280', marginTop: 6, marginBottom: 18, lineHeight: 20 },
  input: {
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 16,
    marginBottom: 12,
    color: '#111827',
    backgroundColor: '#fbfcfe',
  },
  pwWrap: { position: 'relative' },
  pwInput: { paddingRight: 64, marginBottom: 12 },
  pwToggle: {
    position: 'absolute',
    right: 6,
    top: 0,
    bottom: 12,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  pwToggleText: { color: '#011b97', fontWeight: '800', fontSize: 13 },
  error: { color: '#c0392b', marginBottom: 10, fontSize: 13 },
  button: {
    backgroundColor: '#011b97',
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  alertBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  alertCard: { backgroundColor: '#fff', borderRadius: 18, padding: 24, width: '100%', maxWidth: 360, elevation: 10, shadowOpacity: 0.25, shadowRadius: 20 },
  alertTitle: { fontSize: 18, fontWeight: '800', color: '#a5670a', marginBottom: 8 },
  alertBody: { fontSize: 14.5, color: '#374151', lineHeight: 21, marginBottom: 18 },
  alertBtn: { backgroundColor: '#011b97', borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  alertBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
