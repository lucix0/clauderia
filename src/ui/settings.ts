import { DEFAULT_RENDER_DISTANCE, MAX_RENDER_DISTANCE, MIN_RENDER_DISTANCE } from '../config';

export interface Settings {
  /** Multiplier on the base mouse speed. */
  sensitivity: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Render distance in chunks (4–16). */
  renderDistance: number;
  invertY: boolean;
  /** Smooth lighting with ambient occlusion. */
  smoothLighting: boolean;
  /** Sound volume, 0–1. */
  volume: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  sensitivity: 1,
  fov: 70,
  renderDistance: DEFAULT_RENDER_DISTANCE,
  invertY: false,
  smoothLighting: true,
  volume: 0.7,
};

const KEY = 'blocktide.settings.v2';

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
      clampNumber(r['renderDistance'], MIN_RENDER_DISTANCE, MAX_RENDER_DISTANCE, DEFAULT_SETTINGS.renderDistance),
    ),
    invertY: typeof r['invertY'] === 'boolean' ? r['invertY'] : DEFAULT_SETTINGS.invertY,
    smoothLighting: typeof r['smoothLighting'] === 'boolean' ? r['smoothLighting'] : DEFAULT_SETTINGS.smoothLighting,
    volume: clampNumber(r['volume'], 0, 1, DEFAULT_SETTINGS.volume),
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
