import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './src/lib/supabase';
import { resolveOperator, type Operator } from './src/lib/permissions';
import { cacheOperator, getCachedOperator } from './src/lib/offlineAuth';
import { initNotifications } from './src/lib/notifications';
import LoginScreen from './src/screens/LoginScreen';
import AttendanceScreen from './src/screens/AttendanceScreen';

// Top-level gate for the attendance app (requirement 12):
//   no session        -> LoginScreen
//   session + allowed -> AttendanceScreen
//   session + denied  -> "Access denied" card with a sign-out action
// Plus offline sign-in: LoginScreen can hand back a locally-verified Operator
// (cached during a previous online login) when the device has no internet.
export default function AppRoot() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [offlineSignIn, setOfflineSignIn] = useState(false);

  const evaluate = useCallback(async (s: Session | null) => {
    setSession(s);
    if (!s?.user?.email) {
      if (!offlineSignIn) setOperator(null);
      return;
    }
    try {
      const op = await resolveOperator(s.user.email);
      setOperator(op);
      // Remember approved roles locally so offline sign-ins can be authorised.
      if (op.allowed) await cacheOperator(op);
    } catch {
      // Offline / network hiccup: fall back to the locally cached operator.
      const cached = await getCachedOperator(s.user.email);
      setOperator(cached);
    }
  }, [offlineSignIn]);

  useEffect(() => {
    let mounted = true;
    initNotifications();
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      evaluate(data.session ?? null).finally(() => setBooting(false));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      evaluate(s ?? null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [evaluate]);

  const offlineSignInAs = useCallback((op: Operator) => {
    setOfflineSignIn(true);
    setOperator(op);
    setBooting(false);
  }, []);

  const signOut = useCallback(() => {
    setOfflineSignIn(false);
    setOperator(null);
    supabase.auth.signOut().catch(() => {});
  }, []);

  if (booting) {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#ffffff" />
      </View>
    );
  }

  if (offlineSignIn && operator?.allowed) {
    return (
      <>
        <StatusBar style="dark" />
        <AttendanceScreen operator={operator} onSignOut={signOut} />
      </>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen onOfflineSignIn={offlineSignInAs} />
      </>
    );
  }

  if (!operator || !operator.allowed) {
    return (
      <View style={[styles.center, styles.deniedWrap]}>
        <StatusBar style="light" />
        <Text style={styles.deniedTitle}>Access denied</Text>
        <Text style={styles.deniedBody}>
          This account isn't authorised to use the attendance scanner. Only administrators, developers,
          and gate/security staff may sign in here.
        </Text>
        {operator?.email ? <Text style={styles.deniedEmail}>{operator.email}</Text> : null}
        <TouchableOpacity style={styles.deniedBtn} onPress={signOut}>
          <Text style={styles.deniedBtnText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <AttendanceScreen operator={operator} onSignOut={signOut} />
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#011b97', alignItems: 'center', justifyContent: 'center', padding: 24 },
  deniedWrap: {},
  deniedTitle: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 10 },
  deniedBody: { color: '#e6f0e6', fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 8 },
  deniedEmail: { color: '#c7d8f5', fontSize: 13, marginBottom: 20 },
  deniedBtn: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 22, paddingVertical: 12 },
  deniedBtnText: { color: '#011b97', fontWeight: '800', fontSize: 15 },
});
