import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Image,
} from 'react-native';
// RN's built-in SafeAreaView is iOS-only; this one applies the notch/inset
// padding on Android devices too (see SafeAreaProvider in App.tsx).
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import NetInfo from '@react-native-community/netinfo';
import { supabase } from '../lib/supabase';
import { studentPhotoUrl } from '../lib/photo';
import { parseQrPayload, type ScanTarget } from '../lib/qr';
import { applyScan, fetchSettings, type Settings } from '../lib/attendance';
import {
  getQueue,
  enqueue,
  syncQueue,
  removeQueued,
  clearQueue,
  type QueueItem,
} from '../lib/offlineQueue';
import { getCurrentSignInEmail, restoreSession } from '../lib/offlineAuth';
import { initNotifications, syncUnsyncedNotification } from '../lib/notifications';
import type { Operator } from '../lib/permissions';

type Mode = 'student' | 'staff';
type Entry = { key: string; text: string; tone: 'ok' | 'warn' | 'err' };

export default function AttendanceScreen({
  operator,
  onSignOut,
}: {
  operator: Operator;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<Mode>('student');
  const [tab, setTab] = useState<'scan' | 'manual'>('scan');
  const [permission, requestPermission] = useCameraPermissions();
  const [settings, setSettings] = useState<Settings>({ session: '', term: '' });
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [queueModal, setQueueModal] = useState(false);
  const lastScan = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  // manual entry
  const [manualName, setManualName] = useState('');
  const [manualClass, setManualClass] = useState('');
  const [searchResults, setSearchResults] = useState<{ id: string | number; name: string; class?: string; token?: string; passport?: string }[]>([]);
  const [searching, setSearching] = useState(false);
  // student identity confirmation: after picking a name the operator must enter
  // the student's token, which is checked against the record before check-in.
  const [picked, setPicked] = useState<{ id: string | number; name: string; class?: string; token?: string; passport?: string } | null>(null);
  const [manualToken, setManualToken] = useState('');

  const refreshQueue = useCallback(async () => {
    const items = await getQueue();
    setQueue(items);
    // Nudge the operator (device notification) while records sit unsynced.
    syncUnsyncedNotification(items.length);
  }, []);

  useEffect(() => {
    initNotifications();
    fetchSettings().then(setSettings).catch(() => {});
    refreshQueue();
    const unsub = NetInfo.addEventListener((s) => {
      const isOn = s.isConnected === true;
      setOnline(isOn);
      if (isOn) runSync();
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushLog = (e: Entry) => setLog((l) => [e, ...l].slice(0, 40));

  const runSync = useCallback(async () => {
    const items = await getQueue();
    if (items.length === 0) return;
    setSyncing(true);
    // After an offline sign-in there is no Supabase session yet — re-auth
    // silently with the credentials saved on the device so the sync writes
    // under the operator's own account.
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const email = await getCurrentSignInEmail();
      if (email) await restoreSession(email);
    }
    const out = await syncQueue(settings);
    await refreshQueue();
    setSyncing(false);
    if (out.synced > 0) pushLog({ key: `sync-${Date.now()}`, text: `Synced ${out.synced} queued record(s)`, tone: 'ok' });
    if (out.remaining > 0 || out.failed > 0) syncUnsyncedNotification(out.remaining + out.failed);
  }, [settings, refreshQueue]);

  // Core handler shared by QR + manual: try immediately; on failure queue it.
  const handleScan = useCallback(
    async (target: ScanTarget, method: 'qr' | 'manual') => {
      const label = target.kind === 'student' ? target.name : target.name;
      if (online) {
        const res = await applyScan(target, method, settings);
        if (res.ok) {
          pushLog({ key: `${method}-${Date.now()}`, text: res.message, tone: target.kind === mode ? 'ok' : 'ok' });
          return;
        }
        const networkish = /network|failed to fetch|timeout/i.test(res.error || '');
        if (networkish) {
          await enqueue(target, method);
          await refreshQueue();
          pushLog({ key: `q-${Date.now()}`, text: `Saved on device: ${label}`, tone: 'warn' });
          setOnline(false);
          return;
        }
        pushLog({ key: `e-${Date.now()}`, text: `${label}: ${res.error || 'failed'}`, tone: 'err' });
      } else {
        await enqueue(target, method);
        await refreshQueue();
        pushLog({ key: `q-${Date.now()}`, text: `Saved on device: ${label}`, tone: 'warn' });
      }
    },
    [online, settings, mode, refreshQueue],
  );

  const onBarcode = (scanning: { data: string }) => {
    const text = scanning.data;
    const now = Date.now();
    if (text === lastScan.current.text && now - lastScan.current.at < 3000) return; // debounce
    lastScan.current = { text, at: now };
    const parsed = parseQrPayload(text);
    if (!parsed) {
      pushLog({ key: `u-${now}`, text: 'Unrecognized QR code', tone: 'err' });
      return;
    }
    if (parsed.kind !== mode) {
      pushLog({ key: `m-${now}`, text: `Scanned a ${parsed.kind} card — switch to ${parsed.kind} mode?`, tone: 'warn' });
    }
    handleScan(parsed, 'qr');
  };

  const searchManual = async (rawQuery?: string) => {
    const q = (rawQuery ?? manualName).trim();
    if (!q) { setSearchResults([]); return; }
    setSearching(true);
    try {
      if (mode === 'student') {
        const { data } = await supabase
          .from('jmis_student')
          .select('id, name, class, token, passport')
          .ilike('name', `%${q}%`)
          .limit(20);
        setSearchResults((data ?? []).map((r) => ({ id: r.id, name: r.name, class: r.class, token: r.token, passport: r.passport })));
      } else {
        const { data } = await supabase
          .from('jmis_staff')
          .select('id, name')
          .ilike('name', `%${q}%`)
          .limit(20);
        setSearchResults((data ?? []).map((r) => ({ id: r.id, name: r.name })));
      }
    } finally {
      setSearching(false);
    }
  };

  // Live search as the operator types (debounced) so names appear without a tap.
  useEffect(() => {
    if (tab !== 'manual') return;
    const q = manualName.trim();
    if (!q) { setSearchResults([]); return; }
    const t = setTimeout(() => { searchManual(q); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualName, mode, tab]);

  const pickManual = (row: { id: string | number; name: string; class?: string; token?: string; passport?: string }) => {
    if (mode === 'student') {
      // Don't check in yet — ask the student to confirm their token first.
      setPicked(row);
      setManualToken('');
      setSearchResults([]);
      setManualName(row.name);
      return;
    }
    const target: ScanTarget = { kind: 'staff', staffId: String(row.id), name: row.name };
    handleScan(target, 'manual');
    setManualName('');
    setSearchResults([]);
  };

  const confirmStudent = () => {
    if (!picked) return;
    const entered = manualToken.trim().toLowerCase();
    const expected = String(picked.token ?? '').trim().toLowerCase();
    if (!expected) {
      pushLog({ key: `t-${Date.now()}`, text: `${picked.name} has no token on record — contact the office`, tone: 'err' });
      return;
    }
    if (entered !== expected) {
      pushLog({ key: `t-${Date.now()}`, text: `Token does not match ${picked.name} — check-in cancelled`, tone: 'err' });
      setManualToken('');
      return;
    }
    const target: ScanTarget = { kind: 'student', sid: picked.id, name: picked.name, class: picked.class || manualClass };
    handleScan(target, 'manual');
    setPicked(null);
    setManualToken('');
    setManualName('');
    setSearchResults([]);
  };

  const resetManual = () => {
    setPicked(null);
    setManualToken('');
    setManualName('');
    setSearchResults([]);
  };

  const clearAll = () => {
    Alert.alert('Load to Database', `Upload ${queue.length} queued record(s) now?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Upload', onPress: runSync },
    ]);
  };

  const banner = online
    ? { text: 'Online — syncing instantly', bg: '#e7f4e8', fg: '#1e7e34' }
    : { text: `Offline — ${queue.length} record(s) saved on this device`, bg: '#fdf1dc', fg: '#a5670a' };

  const cameraBody = useMemo(() => {
    if (!permission) return <Center><ActivityIndicator color="#011b97" /></Center>;
    if (!permission.granted) {
      return (
        <Center>
          <Text style={styles.camHint}>Camera permission is needed to scan ID cards.</Text>
          <TouchableOpacity style={styles.btn} onPress={requestPermission}>
            <Text style={styles.btnText}>Grant camera access</Text>
          </TouchableOpacity>
        </Center>
      );
    }
    return <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onBarcode} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission]);

  return (
    <SafeAreaView style={styles.safe}>
      {/* header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.h1}>Attendance</Text>
          <Text style={styles.h2}>
            {operator.role === 'gate-staff' ? operator.staffName || 'Gate staff' : operator.role}
            {settings.session ? ` · ${settings.session}` : ''}{settings.term ? ` · ${settings.term}` : ''}
          </Text>
        </View>
        <TouchableOpacity style={styles.signout} onPress={onSignOut}>
          <Text style={styles.signoutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {/* status banner */}
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <View style={[styles.dot, { backgroundColor: banner.fg }]} />
        <Text style={[styles.bannerText, { color: banner.fg }]}>{banner.text}</Text>
        {syncing ? <ActivityIndicator size="small" color={banner.fg} /> : null}
      </View>

      {/* mode segmented control */}
      <View style={styles.segment}>
        {(['student', 'staff'] as Mode[]).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.segmentItem, mode === m && styles.segmentActive]}
            onPress={() => setMode(m)}
          >
            <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
              {m === 'student' ? 'Student' : 'Staff'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* scan / manual tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity style={[styles.tab, tab === 'scan' && styles.tabActive]} onPress={() => setTab('scan')}>
          <Text style={[styles.tabText, tab === 'scan' && styles.tabTextActive]}>Scan QR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, tab === 'manual' && styles.tabActive]} onPress={() => setTab('manual')}>
          <Text style={[styles.tabText, tab === 'manual' && styles.tabTextActive]}>Manual</Text>
        </TouchableOpacity>
      </View>

      {tab === 'scan' ? (
        <View style={styles.cameraWrap}>{cameraBody}</View>
      ) : (
        <View style={styles.manualWrap}>
          {mode === 'student' && picked ? (
            // ---- step 2: confirm the student's token before checking in ----
            <View style={styles.pickedCard}>
              <Text style={styles.pickedLabel}>Selected student</Text>
              <View style={styles.pickedHeadRow}>
                <Avatar passport={picked.passport} size={56} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pickedName}>{picked.name}</Text>
                  {picked.class ? <Text style={styles.resultMeta}>{picked.class}</Text> : null}
                </View>
              </View>
              <Text style={styles.pickedHint}>Ask the student to enter their token to confirm it's them.</Text>
              <TextInput
                style={[styles.manualInput, { marginTop: 6 }]}
                placeholder="Student token"
                placeholderTextColor="#8a93a2"
                autoCapitalize="none"
                value={manualToken}
                onChangeText={setManualToken}
                onSubmitEditing={confirmStudent}
              />
              <View style={styles.pickedActions}>
                <TouchableOpacity style={styles.btnGhost} onPress={resetManual}>
                  <Text style={styles.btnGhostText}>Change</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { flex: 1 }]} onPress={confirmStudent}>
                  <Text style={styles.btnText}>Confirm &amp; Check in</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            // ---- step 1: search by name (results appear live as you type) ----
            <>
              <View style={styles.manualRow}>
                <TextInput
                  style={styles.manualInput}
                  placeholder={mode === 'student' ? 'Search student by name…' : 'Search staff by name…'}
                  placeholderTextColor="#8a93a2"
                  value={manualName}
                  onChangeText={setManualName}
                />
                <TouchableOpacity style={styles.btn} onPress={() => searchManual()}>
                  <Text style={styles.btnText}>{searching ? '…' : 'Search'}</Text>
                </TouchableOpacity>
              </View>
              {mode === 'student' && (
                <TextInput
                  style={[styles.manualInput, { marginTop: 8 }]}
                  placeholder="Class (used if the pick has none)"
                  placeholderTextColor="#8a93a2"
                  value={manualClass}
                  onChangeText={setManualClass}
                />
              )}
              {searchResults.length > 0 && (
                <FlatList
                  style={{ marginTop: 12 }}
                  data={searchResults}
                  keyExtractor={(r) => String(r.id) + r.name}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={styles.resultRow} onPress={() => pickManual(item)}>
                      <View style={styles.resultLeft}>
                        <Avatar passport={item.passport} size={40} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.resultName}>{item.name}</Text>
                          {item.class ? <Text style={styles.resultMeta}>{item.class}</Text> : null}
                        </View>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              )}
              {searchResults.length === 0 && !searching && manualName.trim() ? (
                <Text style={styles.hint}>No matches. Try a different name.</Text>
              ) : null}
            </>
          )}
        </View>
      )}

      {/* recent activity + queue */}
      <View style={styles.logWrap}>
        <Text style={styles.sectionTitle}>Recent</Text>
        <FlatList
          data={log}
          keyExtractor={(e) => e.key}
          ListEmptyComponent={<Text style={styles.hint}>Scans and sign-ins will appear here.</Text>}
          renderItem={({ item }) => (
            <Text style={[styles.logText, item.tone === 'err' ? styles.logErr : item.tone === 'warn' ? styles.logWarn : styles.logOk]}>
              • {item.text}
            </Text>
          )}
          style={styles.logList}
        />
      </View>

      {queue.length > 0 && (
        <View style={styles.queueBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.queueTitle}>{queue.length} waiting to upload</Text>
            <TouchableOpacity onPress={() => setQueueModal(true)}>
              <Text style={styles.queueView}>View</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.btn} onPress={clearAll}>
            <Text style={styles.btnText}>Load to Database</Text>
          </TouchableOpacity>
        </View>
      )}

      <QueueModal
        visible={queueModal}
        onClose={() => setQueueModal(false)}
        queue={queue}
        onRemove={async (uuid) => { await removeQueued(uuid); await refreshQueue(); }}
        onClear={async () => { await clearQueue(); await refreshQueue(); setQueueModal(false); }}
      />
    </SafeAreaView>
  );
}

const Center = ({ children }: { children: React.ReactNode }) => (
  <View style={styles.center}>{children}</View>
);

// Round student photo from the public "passport" bucket, falling back to the
// school crest (also used when the image fails to load).
function Avatar({ passport, size = 40 }: { passport?: string | null; size?: number }) {
  const uri = studentPhotoUrl(passport);
  const [broken, setBroken] = useState(false);
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (uri && !broken) {
    return (
      <Image
        source={{ uri }}
        style={[round, { backgroundColor: '#e6ece6' }]}
        onError={() => setBroken(true)}
      />
    );
  }
  return <Image source={require('../../assets/icon.png')} style={round} />;
}

function QueueModal({
  visible,
  onClose,
  queue,
  onRemove,
  onClear,
}: {
  visible: boolean;
  onClose: () => void;
  queue: QueueItem[];
  onRemove: (uuid: string) => void;
  onClear: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Pending uploads</Text>
          <FlatList
            data={queue}
            keyExtractor={(i) => i.uuid}
            renderItem={({ item }) => (
              <View style={styles.queueRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.queueName}>
                    {item.target.name}
                    {item.target.kind === 'student' ? ` · ${item.target.class}` : ' · staff'}
                  </Text>
                  <Text style={styles.queueMeta}>
                    {item.method} · {new Date(item.createdAt).toLocaleTimeString()} · {item.status}
                    {item.lastError ? ` (${item.lastError})` : ''}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => onRemove(item.uuid)}>
                  <Text style={styles.queueRemove}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.hint}>Nothing pending.</Text>}
          />
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.btnGhost} onPress={onClose}>
              <Text style={styles.btnGhostText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} onPress={onClear}>
              <Text style={styles.btnText}>Clear all</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6f4' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  h1: { fontSize: 22, fontWeight: '800', color: '#011b97' },
  h2: { fontSize: 12.5, color: '#6b7280', marginTop: 2 },
  signout: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#d7dde7' },
  signoutText: { color: '#444', fontWeight: '700', fontSize: 13 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bannerText: { flex: 1, fontWeight: '700', fontSize: 13 },
  segment: { flexDirection: 'row', backgroundColor: '#e6ece6', borderRadius: 999, marginHorizontal: 16, padding: 4 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 999 },
  segmentActive: { backgroundColor: '#011b97' },
  segmentText: { fontWeight: '800', color: '#4b5563' },
  segmentTextActive: { color: '#fff' },
  tabs: { flexDirection: 'row', marginTop: 14, marginBottom: 10, paddingHorizontal: 16, gap: 10 },
  tab: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#d7dde7', backgroundColor: '#fff' },
  tabActive: { borderColor: '#011b97', backgroundColor: '#eef6ee' },
  tabText: { fontWeight: '700', color: '#4b5563' },
  tabTextActive: { color: '#011b97' },
  cameraWrap: { height: 300, marginHorizontal: 16, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  camHint: { color: '#e5e7eb', textAlign: 'center', marginBottom: 12 },
  manualWrap: { paddingHorizontal: 16 },
  manualRow: { flexDirection: 'row', gap: 10 },
  manualInput: { flex: 1, borderWidth: 1, borderColor: '#d7dde7', borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 8, fontSize: 15, backgroundColor: '#fff' },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  resultLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  resultName: { fontWeight: '700', color: '#14201a', fontSize: 15 },
  resultMeta: { color: '#6b7280' },
  pickedCard: { marginTop: 4, padding: 16, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d7dde7' },
  pickedHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  pickedLabel: { fontSize: 11, fontWeight: '800', color: '#022aa1', textTransform: 'uppercase', letterSpacing: 0.5 },
  pickedName: { fontSize: 20, fontWeight: '800', color: '#011b97', marginTop: 2 },
  pickedHint: { color: '#6b7280', fontSize: 13, marginTop: 8, marginBottom: 2 },
  pickedActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  hint: { color: '#8a93a2', marginTop: 8, fontSize: 13 },
  logWrap: { flex: 1, marginTop: 14, paddingHorizontal: 16 },
  sectionTitle: { fontWeight: '800', color: '#011b97', marginBottom: 6, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  logList: { flex: 1 },
  logText: { fontSize: 14, paddingVertical: 4 },
  logOk: { color: '#1e7e34' },
  logWarn: { color: '#a5670a' },
  logErr: { color: '#c0392b' },
  btn: { backgroundColor: '#011b97', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontWeight: '800' },
  btnGhost: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: '#d7dde7' },
  btnGhostText: { color: '#374151', fontWeight: '700' },
  queueBar: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  queueTitle: { fontWeight: '800', color: '#a5670a' },
  queueView: { color: '#022aa1', fontWeight: '700', marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, maxHeight: '70%' },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#011b97', marginBottom: 10 },
  queueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  queueName: { fontWeight: '700', color: '#14201a' },
  queueMeta: { color: '#6b7280', fontSize: 12 },
  queueRemove: { color: '#c0392b', fontWeight: '800', paddingHorizontal: 8 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
});
