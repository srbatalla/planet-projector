import { Body, Equator, Horizon, Observer, SearchAltitude } from 'astronomy-engine';
import { SPECIAL_OBJECTS } from './core/specialObjects';
import type { ProjectionKind } from './views/horizon/projection';
import type { StarMode } from './views/horizon/starField';
import type { CloudMode } from './views/horizon/cloudLayer';
import type { TrailStyle } from './views/horizon/trailPath';
import type { SpiroColorMode } from './views/spirograph/spirographView';

export type ViewMode = 'horizon' | 'spirograph';

export type Settings = {
  view: ViewMode;
  bodies: Body[];
  latitude: number;
  longitude: number;
  elevation: number;
  /**
   * '' = now, 'night' = next nightfall at the observer, otherwise a datetime-local string
   * (viewer's wall clock) or, with a trailing 'Z', a UTC instant (used by historical presets).
   */
  start: string;

  // Horizon
  horizonSpeed: number;
  sampleMinutes: number;
  jump: number;
  trailPersistence: number;
  cycleLimit: number;
  activeFadeRate: number;
  settledBrightness: number;
  checkpoint: number;
  projection: ProjectionKind;
  stars: StarMode;
  clouds: CloudMode;
  cloudCover: number;
  milkyWay: boolean;
  skyTint: boolean;
  lineWidth: number;
  trailStyle: TrailStyle;

  // Spirograph
  spiroSpeed: number;
  spiroStepHours: number;
  perspective: Body;
  /** Special-object ids (comets, asteroids, craft), shown in both views. */
  specials: string[];
  colorMode: SpiroColorMode;
  spiroGlow: boolean;
  spiroLineWidth: number;
  symmetry: number;
  mirror: boolean;
  connect: boolean;
  connectDays: number;
  fadeYears: number;
  zoom: number;

  labels: boolean;
  showStats: boolean;
};

export const BODY_OPTIONS: { label: string; value: Body }[] = [
  { label: 'Sun', value: Body.Sun },
  { label: 'Moon', value: Body.Moon },
  { label: 'Mercury', value: Body.Mercury },
  { label: 'Venus', value: Body.Venus },
  { label: 'Earth', value: Body.Earth },
  { label: 'Mars', value: Body.Mars },
  { label: 'Jupiter', value: Body.Jupiter },
  { label: 'Saturn', value: Body.Saturn },
  { label: 'Uranus', value: Body.Uranus },
  { label: 'Neptune', value: Body.Neptune },
  { label: 'Pluto', value: Body.Pluto },
];

/**
 * Neutral starting point that presets build on. Kept separate from DEFAULTS so changing the
 * first-load experience never alters how a preset looks.
 */
export const BASELINE: Settings = {
  view: 'horizon',
  bodies: [Body.Mars],
  latitude: 37.7749,
  longitude: -122.4194,
  elevation: 0,
  start: '',

  horizonSpeed: 4,
  sampleMinutes: 5,
  jump: 3,
  trailPersistence: 15,
  cycleLimit: 0,
  activeFadeRate: 0.0001,
  settledBrightness: 0.4,
  checkpoint: 10,
  projection: 'panorama',
  stars: 'points',
  clouds: 'off',
  cloudCover: 0.45,
  milkyWay: false,
  skyTint: false,
  lineWidth: 2,
  trailStyle: 'line',

  spiroSpeed: 2,
  spiroStepHours: 24,
  perspective: Body.Earth,
  specials: [],
  colorMode: 'planet',
  spiroGlow: false,
  spiroLineWidth: 1.5,
  symmetry: 1,
  mirror: false,
  connect: false,
  connectDays: 4,
  fadeYears: 0,
  zoom: 1,

  labels: true,
  showStats: true,
};

/** What a visitor sees first: every planet over Sydney, as a star-trail dome. */
export const DEFAULTS: Settings = {
  ...BASELINE,
  bodies: [
    Body.Sun,
    Body.Moon,
    Body.Mercury,
    Body.Venus,
    Body.Mars,
    Body.Jupiter,
    Body.Saturn,
    Body.Uranus,
    Body.Neptune,
  ],
  latitude: -33.8688,
  longitude: 151.2093,
  // A fixed instant (22:32 in Sydney) so the opening sky is the same in every timezone.
  start: '2026-10-03T12:32Z',
  horizonSpeed: 3,
  jump: 1,
  trailPersistence: 12,
  activeFadeRate: 0.0005,
  projection: 'dome',
  stars: 'trails',
  skyTint: true,
  trailStyle: 'glow',
  zoom: 18.48,
};

export const HORIZON_SPEED_STEPS = [1, 1000, 5000, 10000, 20000, 50000, 100000, 500000];
export const SPIRO_SPEED_STEPS = [
  1,
  2500000,
  5000000,
  15000000,
  30000000,
  100000000,
  1000000000,
  Number.POSITIVE_INFINITY,
];

export const LOCATIONS: { label: string; latitude: number; longitude: number }[] = [
  { label: 'San Francisco', latitude: 37.7749, longitude: -122.4194 },
  { label: 'New York', latitude: 40.7128, longitude: -74.006 },
  { label: 'London', latitude: 51.5074, longitude: -0.1278 },
  { label: 'Reykjavík', latitude: 64.1466, longitude: -21.9426 },
  { label: 'Svalbard', latitude: 78.2232, longitude: 15.6267 },
  { label: 'Quito (equator)', latitude: -0.1807, longitude: -78.4678 },
  { label: 'Nairobi', latitude: -1.2921, longitude: 36.8219 },
  { label: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
  { label: 'Sydney', latitude: -33.8688, longitude: 151.2093 },
  { label: 'Cape Town', latitude: -33.9249, longitude: 18.4241 },
  { label: 'McMurdo Station', latitude: -77.8419, longitude: 166.6863 },
];

export function horizonSpeed(settings: Settings) {
  return speedAt(settings.horizonSpeed, HORIZON_SPEED_STEPS);
}

export function spiroSpeed(settings: Settings) {
  return speedAt(settings.spiroSpeed, SPIRO_SPEED_STEPS);
}

/** Lowest index of a speed ladder: 0 is −1×, then mirrored steps down to −(fastest but one). */
export function minSpeedIndex(steps: readonly number[]) {
  return -(steps.length - 1);
}

/**
 * Speed for a signed ladder index: 1…n are the forward steps; 0 and below run time in reverse
 * through the same steps (0 → −1×, −1 → −steps[1], …), so "slower than 1×" means rewinding.
 */
function speedAt(index: number, steps: readonly number[]) {
  const i = Math.max(minSpeedIndex(steps), Math.min(steps.length, Math.round(index)));
  return i >= 1 ? steps[i - 1] : -steps[-i];
}

export function formatSpeed(speed: number): string {
  if (speed < 0) {
    return `◀ ${formatSpeed(-speed)}`;
  }
  if (!Number.isFinite(speed)) {
    return 'Maximum Overdrive';
  }
  if (speed >= 1e9) {
    return `${Math.round(speed / 1e8) / 10}B×`;
  }
  if (speed >= 1e6) {
    return `${Math.round(speed / 1e5) / 10}M×`;
  }
  if (speed >= 1000) {
    return `${Math.round(speed / 1000)}k×`;
  }
  return `${Math.round(speed)}×`;
}

export function formatJump(setting: number) {
  if (setting === 1) {
    return 'None';
  }
  if (setting === 2) {
    return 'Next rise';
  }
  if (setting <= 6) {
    const weeks = setting - 2;
    return `${weeks} wk${weeks === 1 ? '' : 's'}`;
  }
  const months = setting - 6;
  return `${months} mo${months === 1 ? '' : 's'}`;
}

/** Bodies that can be traced in a view: the observer's own planet is excluded. */
export function effectiveBodies(settings: Settings): Body[] {
  const excluded = settings.view === 'horizon' ? Body.Earth : settings.perspective;
  return settings.bodies.filter((body) => body !== excluded);
}

/** Sun altitude that counts as dark enough for stars (nautical dusk). */
const NIGHTFALL_ALTITUDE = -12;

export function resolveStartTime(settings: Settings): Date {
  if (!settings.start) {
    return new Date();
  }
  if (settings.start === 'night') {
    return nextNightfall(settings);
  }
  const parsed = new Date(settings.start);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * The start of a night worth watching: now if at least six dark hours remain, otherwise the
 * next nautical dusk. Falls back to now during polar day.
 */
export function nextNightfall(settings: Settings): Date {
  const now = new Date();
  const observer = new Observer(settings.latitude, settings.longitude, settings.elevation);
  const sun = Equator(Body.Sun, now, observer, true, true);
  if (Horizon(now, observer, sun.ra, sun.dec).altitude < NIGHTFALL_ALTITUDE) {
    const dawn = SearchAltitude(Body.Sun, observer, +1, now, 1, NIGHTFALL_ALTITUDE);
    if (!dawn || dawn.date.getTime() - now.getTime() > 6 * 3600 * 1000) {
      return now;
    }
  }
  const dusk = SearchAltitude(Body.Sun, observer, -1, now, 3, NIGHTFALL_ALTITUDE);
  return dusk ? dusk.date : now;
}

export function toDatetimeLocal(date: Date) {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ------------------------------------------------------------------ URL hash

/** Only non-default values are written, so shared links stay short and survive new defaults. */
export function encodeSettings(settings: Settings): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const value = settings[key];
    const fallback = DEFAULTS[key];
    if (Array.isArray(value)) {
      const joined = value.join(',');
      if (joined !== (fallback as Body[]).join(',')) {
        params.set(key, joined);
      }
    } else if (value !== fallback) {
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
  }
  // Commas and colons are safe in a fragment; keeping them literal makes links readable.
  return params.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}

/** Allowed values for string settings; shared links are untrusted input. */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  view: ['horizon', 'spirograph'],
  projection: ['panorama', 'dome'],
  stars: ['off', 'points', 'trails'],
  clouds: ['off', 'drift', 'exposure'],
  trailStyle: ['line', 'glow'],
  colorMode: ['planet', 'spectrum', 'mono'],
  perspective: BODY_OPTIONS.filter((option) => option.value !== Body.Moon).map((option) => option.value),
};

/** Inclusive ranges for numeric settings (match the controls). */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  latitude: [-89.9, 89.9],
  longitude: [-180, 180],
  elevation: [-500, 9000],
  horizonSpeed: [-(HORIZON_SPEED_STEPS.length - 1), HORIZON_SPEED_STEPS.length],
  sampleMinutes: [0.25, 120],
  jump: [1, 12],
  trailPersistence: [1, 200],
  cycleLimit: [0, 1000],
  activeFadeRate: [0, 0.01],
  settledBrightness: [0, 1],
  cloudCover: [0, 1],
  checkpoint: [2, 30],
  lineWidth: [0.5, 5],
  spiroSpeed: [-(SPIRO_SPEED_STEPS.length - 1), SPIRO_SPEED_STEPS.length],
  spiroStepHours: [1, 720],
  spiroLineWidth: [0.25, 4],
  symmetry: [1, 12],
  connectDays: [1, 90],
  fadeYears: [0, 100],
  zoom: [0.25, 40],
};

export function decodeSettings(hash: string): Partial<Settings> {
  return validateParams(new URLSearchParams(hash.replace(/^#/, '')));
}

/** Validate string-form settings (from a readable or compact link) against types, choices and ranges. */
export function validateParams(params: URLSearchParams): Partial<Settings> {
  const result: Record<string, unknown> = {};
  for (const [key, raw] of params) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      continue;
    }
    const settingKey = key as keyof Settings;
    const fallback = DEFAULTS[settingKey];
    if (settingKey === 'bodies') {
      const names = new Set(raw.split(','));
      result[key] = canonicalBodies(BODY_OPTIONS.map((option) => option.value).filter((name) => names.has(name)));
    } else if (settingKey === 'specials') {
      const ids = new Set(raw.split(','));
      result[key] = SPECIAL_OBJECTS.map((special) => special.id).filter((id) => ids.has(id));
    } else if (typeof fallback === 'boolean') {
      result[key] = raw === '1' || raw === 'true';
    } else if (typeof fallback === 'number') {
      const value = Number(raw);
      const range = RANGES[settingKey];
      if (Number.isFinite(value)) {
        result[key] = range ? Math.min(range[1], Math.max(range[0], value)) : value;
      }
    } else {
      const choices = CHOICES[settingKey];
      if (!choices || choices.includes(raw)) {
        result[key] = raw;
      }
    }
  }
  return result as Partial<Settings>;
}

// ------------------------------------------------------------------ presets

export type Preset = {
  id: string;
  label: string;
  hint: string;
  settings: Partial<Settings>;
};

const thisYear = new Date().getFullYear();

export const PRESETS: Preset[] = [
  {
    id: 'venus-rose',
    label: 'Venus Rose',
    hint: 'Venus seen from Earth traces a five-petal rose every eight years',
    settings: {
      view: 'spirograph',
      bodies: [Body.Venus],
      perspective: Body.Earth,
      spiroSpeed: 4,
      colorMode: 'spectrum',
      spiroGlow: true,
    },
  },
  {
    id: 'dance',
    label: 'Earth–Venus Dance',
    hint: 'Lines joining Earth and Venus every few days weave a mandala',
    settings: {
      view: 'spirograph',
      bodies: [Body.Earth, Body.Venus],
      perspective: Body.Sun,
      spiroSpeed: 4,
      connect: true,
      connectDays: 3,
      spiroGlow: true,
      spiroLineWidth: 1,
    },
  },
  {
    id: 'retrograde',
    label: 'Mars Loops',
    hint: 'Retrograde loops of Mars and Jupiter seen from Earth',
    settings: {
      view: 'spirograph',
      bodies: [Body.Mars, Body.Jupiter],
      perspective: Body.Earth,
      spiroSpeed: 5,
      spiroGlow: true,
    },
  },
  {
    id: 'kaleidoscope',
    label: 'Kaleidoscope',
    hint: 'Mercury and Venus mirrored six ways',
    settings: {
      view: 'spirograph',
      bodies: [Body.Mercury, Body.Venus],
      perspective: Body.Earth,
      spiroSpeed: 5,
      colorMode: 'spectrum',
      spiroGlow: true,
      symmetry: 6,
      mirror: true,
      spiroLineWidth: 1,
      fadeYears: 12,
    },
  },
  {
    id: 'great-conjunction',
    label: 'Great Conjunctions',
    hint: 'Jupiter–Saturn chords trace a slowly turning triangle',
    settings: {
      view: 'spirograph',
      bodies: [Body.Jupiter, Body.Saturn],
      perspective: Body.Sun,
      spiroSpeed: 7,
      spiroStepHours: 72,
      connect: true,
      connectDays: 60,
      spiroGlow: true,
      spiroLineWidth: 1,
      fadeYears: 80,
    },
  },
  {
    id: 'night-dome',
    label: 'Star Trails',
    hint: 'All-sky dome with long-exposure star trails',
    settings: {
      view: 'horizon',
      bodies: [Body.Moon, Body.Mars, Body.Jupiter, Body.Saturn],
      start: 'night',
      projection: 'dome',
      stars: 'trails',
      milkyWay: true,
      jump: 1,
      horizonSpeed: 3,
      trailStyle: 'glow',
    },
  },
  {
    id: 'cloud-streaks',
    label: 'Cloud Streaks',
    hint: 'Long-exposure clouds stream across the dome from dusk into the night',
    settings: {
      view: 'horizon',
      bodies: [Body.Moon, Body.Venus, Body.Mars, Body.Jupiter, Body.Saturn],
      start: 'night',
      projection: 'dome',
      stars: 'trails',
      milkyWay: true,
      clouds: 'exposure',
      cloudCover: 0.5,
      skyTint: true,
      jump: 1,
      horizonSpeed: 3,
      trailStyle: 'glow',
    },
  },
  {
    id: 'midnight-sun',
    label: 'Midnight Sun',
    hint: 'Svalbard in June: the Sun circles without setting',
    settings: {
      view: 'horizon',
      bodies: [Body.Sun, Body.Moon],
      latitude: 78.2232,
      longitude: 15.6267,
      start: `${thisYear}-06-01T00:00`,
      projection: 'dome',
      skyTint: true,
      jump: 1,
      horizonSpeed: 5,
      trailStyle: 'glow',
      // Keep each day's full circle: the default sweep fade would erase most of it.
      activeFadeRate: 0.00001,
    },
  },
  {
    id: 'planet-parade',
    label: 'Planet Parade',
    hint: 'Every naked-eye planet over a panoramic horizon',
    settings: {
      view: 'horizon',
      bodies: [Body.Mercury, Body.Venus, Body.Mars, Body.Jupiter, Body.Saturn],
      start: 'night',
      projection: 'panorama',
      stars: 'points',
      milkyWay: true,
      skyTint: true,
      jump: 2,
      horizonSpeed: 5,
    },
  },
  {
    id: 'hale-bopp',
    label: 'Hale-Bopp 1997',
    hint: 'The great comet over San Francisco, with Mars at opposition',
    settings: {
      view: 'horizon',
      bodies: [Body.Mars],
      specials: ['hale-bopp'],
      latitude: 37.7749,
      longitude: -122.4194,
      start: '1997-03-26T03:00Z',
      projection: 'dome',
      stars: 'trails',
      milkyWay: true,
      skyTint: true,
      jump: 1,
      horizonSpeed: 3,
      trailStyle: 'glow',
    },
  },
  {
    id: 'interstellar',
    label: 'Interstellar Visitors',
    hint: 'ʻOumuamua (2017) and Borisov (2019) cut through the inner solar system',
    settings: {
      view: 'spirograph',
      bodies: [Body.Mercury, Body.Venus, Body.Earth, Body.Mars],
      specials: ['oumuamua', 'borisov'],
      perspective: Body.Sun,
      start: '2017-01-01T00:00Z',
      spiroSpeed: 3,
      spiroGlow: true,
      spiroLineWidth: 1.25,
    },
  },
  {
    id: 'equator',
    label: 'Equator',
    hint: 'From Quito, everything rises straight up',
    settings: {
      view: 'horizon',
      bodies: [Body.Sun, Body.Moon, Body.Venus, Body.Jupiter],
      latitude: -0.1807,
      longitude: -78.4678,
      start: 'night',
      projection: 'panorama',
      stars: 'trails',
      milkyWay: true,
      skyTint: true,
      jump: 1,
      horizonSpeed: 5,
    },
  },
];

/** Bodies in display order, deduplicated: order feeds spectrum hues, so links must agree on it. */
export function canonicalBodies(bodies: readonly Body[]): Body[] {
  const wanted = new Set(bodies);
  return BODY_OPTIONS.map((option) => option.value).filter((body) => wanted.has(body));
}

/** A preset replaces the look entirely but keeps the observer's location unless it sets one. */
export function applyPreset(current: Settings, preset: Preset): Settings {
  const bodies = canonicalBodies(preset.settings.bodies ?? BASELINE.bodies);
  return {
    ...BASELINE,
    latitude: current.latitude,
    longitude: current.longitude,
    elevation: current.elevation,
    showStats: current.showStats,
    labels: current.labels,
    ...preset.settings,
    bodies,
  };
}
