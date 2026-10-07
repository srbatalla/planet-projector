/**
 * Sky colour keyed on the Sun's altitude. Muted on purpose: trails stay the brightest
 * thing on screen even at noon.
 */
const SKY_KEYS: [number, [number, number, number], [number, number, number]][] = [
  [-18, [5, 5, 6], [6, 6, 8]],
  [-12, [5, 7, 13], [11, 13, 26]],
  [-6, [8, 11, 27], [37, 26, 46]],
  [-1, [12, 19, 38], [62, 36, 32]],
  [4, [14, 26, 44], [36, 48, 64]],
  [20, [15, 31, 52], [32, 54, 76]],
  [90, [16, 35, 58], [34, 60, 84]],
];

export const NIGHT_SKY = { zenith: '#050505', horizon: '#050505' };

let cachedKey = Number.NaN;
let cachedColors = NIGHT_SKY;

const rgb = (c: number[]) => `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** Night sky under a bright Moon: a deep blue, brighter toward the horizon. */
const MOONLIT_ZENITH = [12, 18, 34];
const MOONLIT_HORIZON = [22, 30, 50];

/**
 * Sky gradient for the Sun's altitude, brightened toward a moonlit blue by `moonlight`
 * (0..1: phase × how high the Moon is), which only shows once the Sun is well down.
 */
export function skyColors(sunAltitude: number, moonlight = 0) {
  const moonKey = Math.round(moonlight * 20) / 20;
  const key = Math.round(sunAltitude * 4) / 4 + moonKey * 1000;
  if (key === cachedKey) {
    return cachedColors;
  }
  cachedKey = key;
  const values = skyColorValues(Math.round(sunAltitude * 4) / 4, moonKey);
  cachedColors = { zenith: rgb(values.zenith), horizon: rgb(values.horizon) };
  return cachedColors;
}

/** The same sky colours as 0–255 RGB arrays (for lighting the Scene's landscape). */
export function skyColorValues(sunAltitude: number, moonlight = 0) {
  const [zenith, horizon] = sunSky(sunAltitude);
  const night = 1 - Math.min(1, Math.max(0, (sunAltitude + 12) / 8));
  const moon = moonlight * night;
  return { zenith: mix(zenith, MOONLIT_ZENITH, moon), horizon: mix(horizon, MOONLIT_HORIZON, moon) };
}

function sunSky(altitude: number): [number[], number[]] {
  if (altitude <= SKY_KEYS[0][0]) {
    return [SKY_KEYS[0][1], SKY_KEYS[0][2]];
  }
  for (let i = 1; i < SKY_KEYS.length; i += 1) {
    const [alt, zenith, horizon] = SKY_KEYS[i];
    if (altitude <= alt) {
      const [prevAlt, prevZenith, prevHorizon] = SKY_KEYS[i - 1];
      const t = (altitude - prevAlt) / (alt - prevAlt);
      return [mix(prevZenith, zenith, t), mix(prevHorizon, horizon, t)];
    }
  }
  const last = SKY_KEYS[SKY_KEYS.length - 1];
  return [last[1], last[2]];
}

/**
 * 1 in full darkness, fading to 0 by the time the Sun is a few degrees below the horizon; a
 * bright Moon washes out the fainter half of the stars.
 */
export function starVisibility(sunAltitude: number, moonlight = 0) {
  return Math.max(0, Math.min(1, (-sunAltitude - 3) / 9)) * (1 - 0.5 * moonlight);
}

/** How far daylight has washed out a long exposure: 0 until the Sun is 4° below, 1 once it is 1° up. */
export function daylightWash(sunAltitude: number) {
  return Math.max(0, Math.min(1, (sunAltitude + 4) / 5));
}

/** Moonlight strength: illuminated fraction, faded in as the Moon climbs out of the horizon haze. */
export function moonlightStrength(moonAltitude: number, phase: number) {
  if (moonAltitude <= 0) {
    return 0;
  }
  return phase * Math.min(1, moonAltitude / 20);
}

