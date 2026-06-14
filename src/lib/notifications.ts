/**
 * Thin wrapper around the browser Notification API. All functions are safe to
 * call during SSR / where notifications aren't available — they no-op.
 */
export function canNotify(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotificationPermission(): Promise<void> {
  if (!canNotify()) return;
  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {
    /* some browsers reject without a user gesture — ignore */
  }
}

let audioCtx: AudioContext | null = null;

// Short "blip" for incoming private messages. No asset needed (Web Audio).
export function beep(): void {
  if (typeof window === "undefined") return;
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    o.start(t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.stop(t + 0.2);
  } catch {
    /* audio unavailable */
  }
}

// MSN-style "nudge/trillo" — a low buzzy warble.
export function msnNudge(): void {
  if (typeof window === "undefined") return;
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const g = audioCtx.createGain();
    g.gain.value = 0.09;
    g.connect(audioCtx.destination);
    const o = audioCtx.createOscillator();
    o.type = "square";
    // warbling buzz around ~140 Hz for ~0.5s
    o.frequency.setValueAtTime(150, t0);
    for (let i = 0; i < 6; i++) {
      o.frequency.setValueAtTime(i % 2 ? 110 : 165, t0 + i * 0.08);
    }
    o.connect(g);
    o.start(t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    o.stop(t0 + 0.6);
  } catch {
    /* audio unavailable */
  }
}

export function notify(title: string, body: string): void {
  if (!canNotify() || Notification.permission !== "granted") return;
  try {
    // `tag` collapses repeated notifications for the same channel/DM.
    new Notification(title, { body, tag: title });
  } catch {
    /* ignore */
  }
}
