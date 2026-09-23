import { DEFAULT_RENDER_DISTANCE, RENDER_DISTANCES } from '../config';

export interface Settings {
  /** Multiplier on the base mouse speed. */
  sensitivity: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Index into RENDER_DISTANCES. */
  renderDistance: number;
  invertY: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  sensitivity: 1,
  fov: 70,
  renderDistance: DEFAULT_RENDER_DISTANCE,
  invertY: false,
};

const KEY = 'blocktide.settings.v1';

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** Validate anything (e.g. parsed JSON) into a complete Settings object. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    sensitivity: clampNumber(r['sensitivity'], 0.1, 4, DEFAULT_SETTINGS.sensitivity),
    fov: Math.round(clampNumber(r['fov'], 40, 120, DEFAULT_SETTINGS.fov)),
    renderDistance: Math.round(
      clampNumber(r['renderDistance'], 0, RENDER_DISTANCES.length - 1, DEFAULT_SETTINGS.renderDistance),
    ),
    invertY: typeof r['invertY'] === 'boolean' ? r['invertY'] : DEFAULT_SETTINGS.invertY,
  };
}

export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(KEY);
    return sanitizeSettings(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings then last for the session.
  }
}
