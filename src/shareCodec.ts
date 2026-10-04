import { BODY_OPTIONS, decodeSettings, validateParams, type Settings } from './settings';
import { SPECIAL_OBJECTS } from './core/specialObjects';

/**
 * Compact share links: `#z=<base64url>`. Each setting that differs from its frozen base value is
 * written as (field id, value) varints. Ids are append-only and every field carries the base it
 * was introduced with, so old links keep their meaning when app defaults change, and decoders
 * skip ids they do not know.
 */
/** `retired` fields are skipped on encode and ignored on decode; their ids are never reused. */
type FieldKey = keyof Settings | `retired:${string}`;
type Field =
  | { key: FieldKey; kind: 'enum'; choices: readonly string[]; base: string }
  | { key: FieldKey; kind: 'bool'; base: boolean }
  | { key: FieldKey; kind: 'fixed'; scale: number; base: number }
  | { key: FieldKey; kind: 'set'; members: readonly string[]; base: readonly string[] }
  | { key: FieldKey; kind: 'start'; base: string };

const BODY_NAMES = BODY_OPTIONS.map((option) => option.value as string);
/** Frozen, append-only: a special object's position here is its bit in shared links. */
const SPECIAL_IDS = [
  'tesla-roadster', 'apollo-snoopy', 'halley', 'ceres', 'encke', 'hale-bopp', 'oumuamua', 'borisov',
] as const;

// Never reorder or remove entries: the index is the field id inside every shared link.
const FIELDS: Field[] = [
  { key: 'view', kind: 'enum', choices: ['horizon', 'spirograph'], base: 'horizon' },
  { key: 'bodies', kind: 'set', members: BODY_NAMES, base: ['Mars'] },
  { key: 'latitude', kind: 'fixed', scale: 1e4, base: 37.7749 },
  { key: 'longitude', kind: 'fixed', scale: 1e4, base: -122.4194 },
  { key: 'elevation', kind: 'fixed', scale: 1, base: 0 },
  { key: 'start', kind: 'start', base: '' },
  { key: 'horizonSpeed', kind: 'fixed', scale: 1, base: 4 },
  { key: 'sampleMinutes', kind: 'fixed', scale: 100, base: 5 },
  { key: 'jump', kind: 'fixed', scale: 1, base: 3 },
  { key: 'trailPersistence', kind: 'fixed', scale: 1, base: 15 },
  { key: 'cycleLimit', kind: 'fixed', scale: 1, base: 0 },
  { key: 'activeFadeRate', kind: 'fixed', scale: 1e6, base: 0.0001 },
  { key: 'checkpoint', kind: 'fixed', scale: 1, base: 10 },
  { key: 'projection', kind: 'enum', choices: ['panorama', 'dome'], base: 'panorama' },
  { key: 'stars', kind: 'enum', choices: ['off', 'points', 'trails'], base: 'points' },
  { key: 'skyTint', kind: 'bool', base: false },
  { key: 'lineWidth', kind: 'fixed', scale: 100, base: 2 },
  { key: 'trailStyle', kind: 'enum', choices: ['line', 'glow'], base: 'line' },
  { key: 'spiroSpeed', kind: 'fixed', scale: 1, base: 2 },
  { key: 'spiroStepHours', kind: 'fixed', scale: 100, base: 24 },
  { key: 'perspective', kind: 'enum', choices: BODY_NAMES, base: 'Earth' },
  { key: 'specials', kind: 'set', members: SPECIAL_IDS, base: [] },
  { key: 'colorMode', kind: 'enum', choices: ['planet', 'spectrum', 'mono'], base: 'planet' },
  { key: 'spiroGlow', kind: 'bool', base: false },
  { key: 'spiroLineWidth', kind: 'fixed', scale: 100, base: 1.5 },
  { key: 'symmetry', kind: 'fixed', scale: 1, base: 1 },
  { key: 'mirror', kind: 'bool', base: false },
  { key: 'connect', kind: 'bool', base: false },
  { key: 'connectDays', kind: 'fixed', scale: 1, base: 4 },
  { key: 'fadeYears', kind: 'fixed', scale: 1, base: 0 },
  { key: 'zoom', kind: 'fixed', scale: 100, base: 1 },
  { key: 'labels', kind: 'bool', base: true },
  { key: 'showStats', kind: 'bool', base: true },
  { key: 'retired:clearStarsAtSunrise', kind: 'bool', base: false },
  { key: 'settledBrightness', kind: 'fixed', scale: 100, base: 0.4 },
  { key: 'clouds', kind: 'enum', choices: ['off', 'drift', 'exposure'], base: 'off' },
  { key: 'cloudCover', kind: 'fixed', scale: 100, base: 0.45 },
  { key: 'milkyWay', kind: 'bool', base: false },
];

const FORMAT_VERSION = 1;
export const COMPACT_PREFIX = 'z=';

// New special objects must be appended to SPECIAL_IDS (and bodies to the end of BODY_OPTIONS).
if (import.meta.env.DEV) {
  for (const special of SPECIAL_OBJECTS) {
    if (!(SPECIAL_IDS as readonly string[]).includes(special.id)) {
      console.warn(`shareCodec: special object '${special.id}' is missing from the link format`);
    }
  }
}

// ------------------------------------------------------------------ varints

function writeVarint(out: number[], value: number) {
  let v = Math.max(0, Math.floor(value));
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

function readVarint(bytes: Uint8Array, cursor: { i: number }): number {
  let value = 0;
  let multiplier = 1;
  for (let n = 0; n < 8; n += 1) {
    if (cursor.i >= bytes.length) {
      throw new Error('truncated');
    }
    const byte = bytes[cursor.i];
    cursor.i += 1;
    value += (byte & 0x7f) * multiplier;
    if (byte < 0x80) {
      return value;
    }
    multiplier *= 0x80;
  }
  throw new Error('varint too long');
}

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

// ------------------------------------------------------------------ base64url

function toBase64Url(bytes: number[]) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ------------------------------------------------------------------ start time

/**
 * '' → 0, 'night' → 1, otherwise 2 + 2·zigzag(minutes) + utc, where minutes are the written
 * wall-clock fields read as UTC and `utc` marks a trailing 'Z' (a fixed instant).
 */
function encodeStart(start: string): number {
  if (start === '') return 0;
  if (start === 'night') return 1;
  const match = /^(-?\d+)-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(start);
  if (!match) return 0;
  const [, y, mo, d, h, mi] = match.map(Number);
  const utc = start.endsWith('Z') ? 1 : 0;
  return 2 + 2 * zigzag(Math.round(Date.UTC(y, mo - 1, d, h, mi) / 60000)) + utc;
}

function decodeStart(code: number): string {
  if (code === 0) return '';
  if (code === 1) return 'night';
  const utc = (code - 2) % 2 === 1;
  const date = new Date(unzigzag(Math.floor((code - 2) / 2)) * 60000);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${utc ? 'Z' : ''}`;
}

// ------------------------------------------------------------------ codec

function encodeValue(field: Field, value: unknown): number | null {
  switch (field.kind) {
    case 'enum': {
      const index = field.choices.indexOf(String(value));
      return index >= 0 ? index : null;
    }
    case 'bool':
      return value ? 1 : 0;
    case 'fixed':
      return zigzag(Math.round(Number(value) * field.scale));
    case 'set':
      return (value as string[]).reduce((mask, name) => {
        const index = field.members.indexOf(name);
        return index >= 0 ? mask + 2 ** index : mask;
      }, 0);
    case 'start':
      return encodeStart(String(value));
  }
}

function decodeValue(field: Field, code: number): string {
  switch (field.kind) {
    case 'enum':
      return field.choices[code] ?? '';
    case 'bool':
      return code ? '1' : '0';
    case 'fixed':
      return String(unzigzag(code) / field.scale);
    case 'set':
      return field.members.filter((_, index) => Math.floor(code / 2 ** index) % 2 === 1).join(',');
    case 'start':
      return decodeStart(code);
  }
}

function baseOf(field: Field) {
  return field.kind === 'set' ? [...field.base] : field.base;
}

export function encodeCompact(settings: Settings): string {
  const bytes: number[] = [FORMAT_VERSION];
  FIELDS.forEach((field, id) => {
    if (field.key.startsWith('retired:')) {
      return;
    }
    const value = settings[field.key as keyof Settings];
    const base = baseOf(field);
    const same = Array.isArray(value) ? value.join(',') === (base as string[]).join(',') : value === base;
    if (same) {
      return;
    }
    const code = encodeValue(field, value);
    if (code !== null) {
      writeVarint(bytes, id);
      writeVarint(bytes, code);
    }
  });
  return toBase64Url(bytes);
}

/**
 * Decode to the same string form as a readable fragment so it goes through the same validation.
 * Every known field is emitted (absent ones at their frozen base), making links independent of
 * the app's current defaults. Returns null for anything that is not a valid compact payload.
 */
export function decodeCompact(payload: string): URLSearchParams | null {
  try {
    const bytes = fromBase64Url(payload);
    if (bytes.length === 0 || bytes[0] !== FORMAT_VERSION) {
      return null;
    }
    const values = new Map<string, string>();
    for (const field of FIELDS) {
      if (field.key.startsWith('retired:')) {
        continue;
      }
      const base = baseOf(field);
      values.set(field.key, Array.isArray(base) ? base.join(',') : field.kind === 'bool' ? (base ? '1' : '0') : String(base));
    }
    const cursor = { i: 1 };
    while (cursor.i < bytes.length) {
      const id = readVarint(bytes, cursor);
      const code = readVarint(bytes, cursor);
      const field = FIELDS[id];
      if (field && !field.key.startsWith('retired:')) {
        values.set(field.key, decodeValue(field, code));
      }
    }
    return new URLSearchParams(Array.from(values.entries()) as [string, string][]);
  } catch {
    return null;
  }
}

/** Settings from a URL fragment in either form: compact (`#z=…`) or readable (`#view=…&…`). */
export function parseHash(hash: string): Partial<Settings> {
  const fragment = hash.replace(/^#/, '');
  if (fragment.startsWith(COMPACT_PREFIX)) {
    const params = decodeCompact(fragment.slice(COMPACT_PREFIX.length));
    return params ? validateParams(params) : {};
  }
  return decodeSettings(fragment);
}
