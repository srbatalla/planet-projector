import { Body } from 'astronomy-engine';

/**
 * Color palette for planetary traces.
 * Colors chosen for visual distinctness and rough approximation of actual planet colors:
 * the warm bodies are separated by lightness and saturation so thin trails stay legible
 * when several share the sky.
 */
export const PLANET_COLORS: Record<string, string> = {
  [Body.Sun]: '#ffd23f',      // Saturated gold
  [Body.Earth]: '#4c8eda',    // Blue
  [Body.Mercury]: '#a9adb5',  // Cool gray
  [Body.Venus]: '#fff3c9',    // Pale cream
  [Body.Mars]: '#ff6b4a',     // Red-orange
  [Body.Jupiter]: '#ff9f5a',  // Peach orange
  [Body.Saturn]: '#cbb27a',   // Muted butterscotch
  [Body.Uranus]: '#4fd9ff',   // Cyan
  [Body.Neptune]: '#5b7bff',  // Royal blue
  [Body.Moon]: '#dde5f0',     // Cool silver
  [Body.Pluto]: '#e3a99f',    // Dusty rose
};

/**
 * Get the display color for a given celestial body.
 * Falls back to white if body not in palette.
 */
export function getPlanetColor(body: Body): string {
  return PLANET_COLORS[body] || '#e5e5e5';
}
