import { Body } from 'astronomy-engine';

/**
 * Color palette for planetary traces.
 * Colors chosen for visual distinctness and rough approximation of actual planet colors.
 */
export const PLANET_COLORS: Record<string, string> = {
  [Body.Sun]: '#ffff00',      // Yellow
  [Body.Earth]: '#4c8eda',    // Blue
  [Body.Mercury]: '#b8b8b8',  // Gray
  [Body.Venus]: '#ffd700',    // Gold
  [Body.Mars]: '#ff6b4a',     // Red-orange
  [Body.Jupiter]: '#daa520',  // Goldenrod
  [Body.Saturn]: '#f4a460',   // Sandy brown
  [Body.Uranus]: '#4fd9ff',   // Cyan
  [Body.Neptune]: '#4169e1',  // Royal blue
  [Body.Moon]: '#e8e8e8',     // Light gray
};

/**
 * Get the display color for a given celestial body.
 * Falls back to white if body not in palette.
 */
export function getPlanetColor(body: Body): string {
  return PLANET_COLORS[body] || '#e5e5e5';
}
