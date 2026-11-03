import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

// Loud two-tone chirp played after every successful scan so the gate operator
// hears confirmation without watching the screen. The player is created once
// and rewound on each replay; the toggle that enables/disables it lives in the
// attendance screen header (persisted to AsyncStorage).
const SOUND_PREF_KEY = 'bluebell_attendance_sound_v1';

export async function loadSoundPref(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SOUND_PREF_KEY)) !== 'off';
  } catch {
    return true;
  }
}

export async function saveSoundPref(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(SOUND_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* preference is best-effort */
  }
}

let player: AudioPlayer | null = null;
let initStarted = false;

export async function initSound(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  try {
    // Stay audible even when the phone is on silent, and briefly duck music.
    await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'duckOthers' });
    player = createAudioPlayer(require('../../assets/beep.wav'));
  } catch {
    // Audio is a nicety; never break scanning when it fails.
  }
}

export function playBeep(): void {
  if (!player) {
    void initSound();
    return;
  }
  try {
    player.seekTo(0);
    player.play();
  } catch {
    /* ignore */
  }
}
