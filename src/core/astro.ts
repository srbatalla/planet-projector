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

export const normalizeAzimuth = (degrees: number) => {
  let az = degrees % 360;
  if (az < 0) {
    az += 360;
  }

  return az;
};
