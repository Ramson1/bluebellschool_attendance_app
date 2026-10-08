import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

// Local device notifications that nag the gate operator when attendance
// records are sitting in the offline queue unsynced. These are on-device
// notifications (no push server needed): they fire while the app is open or
// in the background, and are re-armed on every app start from the persisted
// queue.
const CHANNEL = 'attendance-sync';

let scheduledId: string | null = null;
let lastNaggedCount = -1;

let configured = false;
export async function initNotifications(): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    // Show banners while the app is in the foreground too.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Attendance sync',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#a5670a',
      });
    }
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) await Notifications.requestPermissionsAsync();
  } catch {
    // Notifications are best-effort; never break attendance on them.
  }
}

/**
 * Keep the device notification in sync with the pending-queue count:
 *  - 0 pending (or everything synced) -> cancel any pending reminder
 *  - count grew since the last nag   -> remind the user to connect to the internet
 */
export async function syncUnsyncedNotification(count: number): Promise<void> {
  try {
    if (count <= 0) {
      if (scheduledId) {
        await Notifications.cancelScheduledNotificationAsync(scheduledId);
        scheduledId = null;
      }
      lastNaggedCount = -1;
      return;
    }
    if (count === lastNaggedCount) return; // already reminded about this many
    if (scheduledId) {
      await Notifications.cancelScheduledNotificationAsync(scheduledId);
      scheduledId = null;
    }
    scheduledId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Unsynced attendance',
        body: `${count} attendance record(s) are saved on this device. Connect to the internet so they can be sent to the server.`,
        data: { type: 'attendance-unsynced', count },
      },
      trigger: {
        channelId: CHANNEL,
        seconds: 3,
      },
    });
    lastNaggedCount = count;
  } catch {
    // best-effort
  }
}
