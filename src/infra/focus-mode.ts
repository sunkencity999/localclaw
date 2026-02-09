/**
 * Focus mode — suppress heartbeat delivery and notifications during deep work.
 *
 * When active, heartbeats still run (to maintain session context) but
 * their output is buffered rather than delivered. When focus mode ends,
 * any buffered alerts are delivered as a single digest.
 */

export type FocusModeState = {
  active: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  reason: string | null;
  bufferedAlerts: string[];
};

const state: FocusModeState = {
  active: false,
  startedAt: null,
  expiresAt: null,
  reason: null,
  bufferedAlerts: [],
};

let expiryTimer: NodeJS.Timeout | null = null;
const listeners = new Set<(active: boolean) => void>();

export function isFocusModeActive(): boolean {
  if (!state.active) {
    return false;
  }
  if (state.expiresAt !== null && Date.now() >= state.expiresAt) {
    endFocusMode();
    return false;
  }
  return true;
}

export function getFocusModeState(): Readonly<FocusModeState> {
  return { ...state, bufferedAlerts: [...state.bufferedAlerts] };
}

export function startFocusMode(opts?: { durationMs?: number; reason?: string }): void {
  const now = Date.now();
  state.active = true;
  state.startedAt = now;
  state.reason = opts?.reason ?? null;
  state.expiresAt = opts?.durationMs && opts.durationMs > 0 ? now + opts.durationMs : null;
  state.bufferedAlerts = [];

  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  if (state.expiresAt !== null) {
    const delay = state.expiresAt - now;
    expiryTimer = setTimeout(() => {
      endFocusMode();
    }, delay);
    expiryTimer.unref?.();
  }

  notifyListeners(true);
}

export function endFocusMode(): { bufferedAlerts: string[] } {
  const alerts = [...state.bufferedAlerts];
  state.active = false;
  state.startedAt = null;
  state.expiresAt = null;
  state.reason = null;
  state.bufferedAlerts = [];

  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  notifyListeners(false);
  return { bufferedAlerts: alerts };
}

export function bufferFocusModeAlert(alert: string): void {
  if (state.active) {
    state.bufferedAlerts.push(alert);
  }
}

export function onFocusModeChange(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(active: boolean): void {
  for (const listener of listeners) {
    try {
      listener(active);
    } catch {
      /* ignore */
    }
  }
}
