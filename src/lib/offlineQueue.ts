import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { applyScan, type Settings } from './attendance';
import type { ScanTarget } from './qr';

// Offline-first queue. Every scan becomes a small "intent" record. When online
// we replay them through applyScan in order; each replay re-reads the current
// DB row so a queued sign-in followed by a queued sign-out still resolve to the
// right toggle at sync time. Client UUIDs keep double-syncs idempotent and the
// unique(student_name,class,date) constraint dedupes on the server.
const KEY = 'jmis_attendance_queue_v1';

export type QueueStatus = 'queued' | 'syncing' | 'failed';
export type QueueItem = {
  uuid: string;
  target: ScanTarget;
  method: 'qr' | 'manual';
  createdAt: string;
  status: QueueStatus;
  tries: number;
  lastError?: string;
};

export const newId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export async function getQueue(): Promise<QueueItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueueItem[]) : [];
  } catch {
    return [];
  }
}

async function setQueue(items: QueueItem[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}

export async function enqueue(target: ScanTarget, method: 'qr' | 'manual'): Promise<QueueItem> {
  const item: QueueItem = {
    uuid: newId(),
    target,
    method,
    createdAt: new Date().toISOString(),
    status: 'queued',
    tries: 0,
  };
  const items = await getQueue();
  items.push(item);
  await setQueue(items);
  return item;
}

export async function removeQueued(uuid: string): Promise<void> {
  const items = await getQueue();
  await setQueue(items.filter((i) => i.uuid !== uuid));
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

export type SyncOutcome = { synced: number; failed: number; remaining: number };

// Replay all queued/pending items in FIFO order. A network error while
// processing aborts the run and leaves the rest queued for the next attempt.
export async function syncQueue(settings: Settings): Promise<SyncOutcome> {
  const online = (await NetInfo.fetch()).isConnected === true;
  if (!online) {
    const items = await getQueue();
    return { synced: 0, failed: 0, remaining: items.length };
  }

  let items = await getQueue();
  let synced = 0;
  let failed = 0;

  for (const item of [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const mark = async (patch: Partial<QueueItem>) => {
      items = await getQueue();
      await setQueue(items.map((i) => (i.uuid === item.uuid ? { ...i, ...patch } : i)));
    };
    await mark({ status: 'syncing' });

    const res = await applyScan(item.target, item.method, settings);
    if (res.ok) {
      // Success: drop it from the queue.
      items = await getQueue();
      await setQueue(items.filter((i) => i.uuid !== item.uuid));
      synced += 1;
    } else {
      await mark({ status: 'failed', tries: item.tries + 1, lastError: res.error || 'Sync failed' });
      failed += 1;
      // A hard network error means the rest will fail too — stop early.
      if (/network|failed to fetch|timeout/i.test(res.error || '')) break;
    }
  }

  const remaining = (await getQueue()).filter((i) => i.status !== 'failed').length;
  return { synced, failed, remaining };
}

export async function isOnline(): Promise<boolean> {
  return (await NetInfo.fetch()).isConnected === true;
}
