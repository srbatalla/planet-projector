import {
  Body,
  Equator,
  Horizon,
  Observer,
  type EquatorialCoordinates,
} from 'astronomy-engine';

export type HorizonSample = {
  time: Date;
  altitude: number;
  azimuth: number;
};

export type HorizonSampleConfig = {
  body: Body;
  observer: Observer;
  startTime: Date;
  durationMinutes: number;
  stepMinutes: number;
  refraction?: 'normal' | 'none';
};

export type HorizonPointRequest = {
  body: Body;
  observer: Observer;
  time: Date;
  refraction?: 'normal' | 'none';
};

const clampStepMinutes = (minutes: number) => {
  const step = Math.max(0.25, minutes);
  return Number.isFinite(step) ? step : 1;
};

export function sampleHorizonTrack(config: HorizonSampleConfig): HorizonSample[] {
  const {
    body,
    observer,
    startTime,
    durationMinutes,
    refraction = 'normal',
  } = config;
  const stepMinutes = clampStepMinutes(config.stepMinutes);
  const totalMinutes = Math.max(stepMinutes, durationMinutes);
  const sampleCount = Math.ceil(totalMinutes / stepMinutes) + 1;
  const samples: HorizonSample[] = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const minutesOffset = i * stepMinutes;
    const time = new Date(startTime.getTime() + minutesOffset * 60 * 1000);
    const equatorial: EquatorialCoordinates = Equator(body, time, observer, true, true);
    const horizontal = Horizon(time, observer, equatorial.ra, equatorial.dec, refraction);
    samples.push({
      time,
      altitude: horizontal.altitude,
      azimuth: normalizeAzimuth(horizontal.azimuth),
    });
  }

  return samples;
}

export function computeHorizonPoint(request: HorizonPointRequest): HorizonSample {
  const { body, observer, time, refraction = 'normal' } = request;
  const equatorial: EquatorialCoordinates = Equator(body, time, observer, true, true);
  const horizontal = Horizon(time, observer, equatorial.ra, equatorial.dec, refraction);
  return {
    time,
    altitude: horizontal.altitude,
    azimuth: normalizeAzimuth(horizontal.azimuth),
  };
}

/**
 * Horizon samples for one body, with `Equator` (the expensive part: light-time, nutation,
 * aberration) evaluated only on a coarse time grid and interpolated in between. RA/Dec move
 * smoothly, so the interpolation error is ~0.001° while each sample costs ~15× less.
 */
export class InterpolatedHorizonTrack {
  private readonly nodeMs: number;
  private readonly nodes = new Map<number, { ra: number; dec: number }>();
  private readonly date = new Date();

  /** `equatorAt` returns RA (hours) / Dec (degrees) of date for the observer. */
  constructor(
    private readonly equatorAt: (date: Date) => { ra: number; dec: number },
    nodeMinutes: number,
    private readonly observer: Observer,
    private readonly refraction: 'normal' | 'none' = 'normal'
  ) {
    this.nodeMs = nodeMinutes * 60 * 1000;
  }

  private node(index: number) {
    let node = this.nodes.get(index);
    if (!node) {
      if (this.nodes.size > 512) {
        this.nodes.clear();
      }
      this.date.setTime(index * this.nodeMs);
      const equatorial = this.equatorAt(this.date);
      node = { ra: equatorial.ra, dec: equatorial.dec };
      this.nodes.set(index, node);
    }
    return node;
  }

  sample(timeMs: number): HorizonSample {
    const index = Math.floor(timeMs / this.nodeMs);
    const t = (timeMs - index * this.nodeMs) / this.nodeMs;
    const a = this.node(index);
    const b = this.node(index + 1);
    let raDelta = b.ra - a.ra;
    if (raDelta > 12) raDelta -= 24;
    else if (raDelta < -12) raDelta += 24;
    let ra = a.ra + raDelta * t;
    if (ra < 0) ra += 24;
    else if (ra >= 24) ra -= 24;
    const dec = a.dec + (b.dec - a.dec) * t;

    const time = new Date(timeMs);
    const horizontal = Horizon(time, this.observer, ra, dec, this.refraction);
    return {
      time,
      altitude: horizontal.altitude,
      azimuth: normalizeAzimuth(horizontal.azimuth),
    };
  }
}

export const normalizeAzimuth = (degrees: number) => {
  let az = degrees % 360;
  if (az < 0) {
    az += 360;
  }

  return az;
};
