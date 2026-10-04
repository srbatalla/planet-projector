import { Body, Equator, type Observer } from 'astronomy-engine';
import { specialEquatorOfDate } from '../core/orbits';
import type { SpecialObject } from '../core/specialObjects';
import { getPlanetColor } from './horizon/planetColors';

/** Anything a view can trace: a planet (ephemeris) or a special object (Keplerian elements). */
export type SkyTarget = {
  /** Unique across both kinds: the Body name or the special object's id. */
  id: string;
  label: string;
  color: string;
  body: Body | null;
  special: SpecialObject | null;
};

export function bodyTarget(body: Body): SkyTarget {
  return { id: body, label: body, color: getPlanetColor(body), body, special: null };
}

export function specialTarget(special: SpecialObject): SkyTarget {
  return { id: special.id, label: special.shortName, color: special.color, body: null, special };
}

/** Where a target's RA/Dec (of date) comes from, and how densely to sample it for interpolation. */
export function equatorSource(target: SkyTarget, observer: Observer) {
  if (target.special) {
    const special = target.special;
    return { equatorAt: (date: Date) => specialEquatorOfDate(special, date), nodeMinutes: 60 };
  }
  const body = target.body as Body;
  return {
    equatorAt: (date: Date) => Equator(body, date, observer, true, true),
    // The Moon moves ~0.5°/h and its topocentric parallax swings daily: sample it more densely.
    nodeMinutes: body === Body.Moon ? 20 : 120,
  };
}
