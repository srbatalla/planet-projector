import { Body, Observer } from 'astronomy-engine';
import { computeHorizonPoint, type HorizonSample } from '../../core/astro';
import { CanvasSurface } from '../../render/canvas';

/**
 * Horizon view configuration.
 */
type HorizonViewConfig = {
  body: Body;
  observer: Observer;
  sampleMinutes: number;
  startTime: Date;
  playbackSpeed: number;
  horizonCutoff: number;
  autoHorizon: boolean;
  trailFade: number;
  jumpSetting: number;
  trailPersistence: number;
  cycleLimit: number;
};

type AltitudeRange = {
  min: number;
  max: number;
};

type SamplePoint = {
  azimuth: number;
  altitude: number;
};

const MAX_LOOKAHEAD_HOURS = 400;

export class HorizonView {
  private surface: CanvasSurface;
  private animationHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private readonly altitudeRange: AltitudeRange = { min: -10, max: 90 };
  private readonly stepMs: number;
  private readonly baseTimestamp: number;
  private simTimeMs = 0;
  private remainderMs = 0;
  private currentSample: HorizonSample | null = null;
  private lastVisibleSample: HorizonSample | null = null;
  private lastVisibleTimeMs = 0;
  private readonly activeTrail = createTrailLayer();
  private readonly jumpSetting: number;
  private readonly historyPersistence: number;
  private readonly cycleLimit: number;
  private completedCycles = 0;
  private activeHasPaint = false;
  private historyLayers: HistoryLayer[] = [];

  constructor(private container: HTMLElement, private config: HorizonViewConfig) {
    this.stepMs = Math.max(1, this.config.sampleMinutes * 60 * 1000);
    this.baseTimestamp = this.config.startTime.getTime();

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.container.appendChild(canvas);

    this.surface = new CanvasSurface(canvas);
    this.jumpSetting = this.config.jumpSetting;
    this.historyPersistence = Math.max(1, this.config.trailPersistence);
    this.cycleLimit = Math.max(0, this.config.cycleLimit);

    this.syncTrailCanvas(this.activeTrail);
    clearTrailLayer(this.activeTrail);

    window.addEventListener('resize', this.handleResize, { passive: true });
  }

  start() {
    if (this.animationHandle !== null) {
      return;
    }

    this.animationHandle = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
  }

  private loop = (timestamp: number) => {
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
    }

    const deltaTime = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;

    this.advanceSimulation(deltaTime * this.config.playbackSpeed);
    this.render(deltaTime);
    this.animationHandle = requestAnimationFrame(this.loop);
  };

  private advanceSimulation(deltaSimMs: number) {
    if (deltaSimMs <= 0) {
      return;
    }

    this.remainderMs += deltaSimMs;
    const stepsToProcess = Math.floor(this.remainderMs / this.stepMs);
    for (let i = 0; i < stepsToProcess; i += 1) {
      this.remainderMs -= this.stepMs;
      this.processStep(this.stepMs);
    }

    const previewTime = this.simTimeMs + this.remainderMs;
    const previewSample = this.computeSampleAt(previewTime);
    if (this.isSampleVisible(previewSample)) {
      this.currentSample = previewSample;
    } else {
      const nextVisible = this.seekNextVisibleSample(previewTime);
      this.currentSample = nextVisible?.sample ?? null;
      if (nextVisible) {
        this.simTimeMs = nextVisible.timeMs;
        this.remainderMs = 0;
      }
    }
  }

  private processStep(stepMs: number) {
    this.simTimeMs += stepMs;

    let sample = this.computeSampleAt(this.simTimeMs);
    if (!this.isSampleVisible(sample)) {
      if (this.lastVisibleSample) {
        const exitPoint = this.refineHorizonCrossing(
          { timeMs: this.lastVisibleTimeMs, sample: this.lastVisibleSample },
          { timeMs: this.simTimeMs, sample },
        );
        this.paintSegment(this.lastVisibleSample, exitPoint.sample, this.activeTrail, true);
        this.lastVisibleSample = null;
        this.completeCycle();
      }

      const nextVisible = this.seekNextVisibleSample(this.simTimeMs);
      if (!nextVisible) {
        this.currentSample = null;
        return;
      }

      this.simTimeMs = nextVisible.timeMs;
      this.remainderMs = 0;
      sample = nextVisible.sample;
    }

    if (this.lastVisibleSample) {
      this.paintSegment(this.lastVisibleSample, sample, this.activeTrail, false);
    }

    this.lastVisibleSample = sample;
    this.lastVisibleTimeMs = this.simTimeMs;
    this.currentSample = sample;
  }

  private computeSampleAt(simTimeMs: number): HorizonSample {
    const time = new Date(this.baseTimestamp + simTimeMs);
    return computeHorizonPoint({
      body: this.config.body,
      observer: this.config.observer,
      time,
    });
  }

  private seekNextVisibleSample(fromTimeMs: number) {
    const jumpMs = this.getJumpMilliseconds();
    const maxIterations = Math.ceil(
      (MAX_LOOKAHEAD_HOURS * 3600 * 1000) / Math.max(1, this.stepMs),
    );

    let timeMs = fromTimeMs + jumpMs;
    let below: { timeMs: number; sample: HorizonSample } | null = null;
    for (let i = 0; i < maxIterations; i += 1) {
      const sample = this.computeSampleAt(timeMs);
      if (this.isSampleVisible(sample)) {
        let resultTime = timeMs;
        let resultSample = sample;
        if (below) {
          const refined = this.refineHorizonCrossing(below, { timeMs, sample });
          resultTime = refined.timeMs;
          resultSample = refined.sample;
        }
        this.lastVisibleSample = null;
        this.activeHasPaint = false;
        return { sample: resultSample, timeMs: resultTime };
      }

      below = { timeMs, sample };
      timeMs += this.stepMs;
    }

    return null;
  }

  private refineHorizonCrossing(
    below: { timeMs: number; sample: HorizonSample },
    above: { timeMs: number; sample: HorizonSample },
  ) {
    let low = below.timeMs;
    let high = above.timeMs;
    let lowSample = below.sample;
    let highSample = above.sample;

    // Binary search to narrow down the crossing
    for (let i = 0; i < 20 && high - low > 1000; i += 1) {
      const mid = (low + high) / 2;
      const midSample = this.computeSampleAt(mid);
      if (this.isSampleVisible(midSample)) {
        high = mid;
        highSample = midSample;
      } else {
        low = mid;
        lowSample = midSample;
      }
    }

    // Interpolate to find exact horizon crossing point
    const crossingSample = this.findExactHorizonCrossing(lowSample, highSample);
    const crossingTime = this.interpolateTime(low, high, lowSample, highSample, crossingSample);

    return { timeMs: crossingTime, sample: crossingSample };
  }

  private findExactHorizonCrossing(
    below: HorizonSample,
    above: HorizonSample,
  ): HorizonSample {
    // Get horizon cutoffs at both azimuths
    const cutoffBelow = this.getHorizonCutoffForAzimuth(below.azimuth);
    const cutoffAbove = this.getHorizonCutoffForAzimuth(above.azimuth);

    // Interpolate azimuth linearly
    const azimuthDelta = ((((above.azimuth - below.azimuth) % 360) + 540) % 360) - 180;

    // Find t where interpolated altitude equals interpolated horizon cutoff
    // altitude(t) = lerp(below.altitude, above.altitude, t)
    // cutoff(t) = lerp(cutoffBelow, cutoffAbove, t)
    // Solve: lerp(below.altitude, above.altitude, t) = lerp(cutoffBelow, cutoffAbove, t)

    const altDelta = above.altitude - below.altitude;
    const cutoffDelta = cutoffAbove - cutoffBelow;
    const numerator = cutoffBelow - below.altitude;
    const denominator = altDelta - cutoffDelta;

    // Handle edge cases
    let t = 0.5;
    if (Math.abs(denominator) > 1e-6) {
      t = numerator / denominator;
      t = Math.max(0, Math.min(1, t)); // Clamp to [0, 1]
    }

    const crossingAzimuth = wrapAngle(below.azimuth + azimuthDelta * t);
    const crossingAltitude = below.altitude + altDelta * t;

    return {
      time: new Date(below.time.getTime() + (above.time.getTime() - below.time.getTime()) * t),
      azimuth: crossingAzimuth,
      altitude: crossingAltitude,
    };
  }

  private interpolateTime(
    lowTime: number,
    highTime: number,
    lowSample: HorizonSample,
    highSample: HorizonSample,
    crossingSample: HorizonSample,
  ): number {
    // Interpolate time based on altitude change
    const altDelta = highSample.altitude - lowSample.altitude;
    if (Math.abs(altDelta) < 1e-6) {
      return (lowTime + highTime) / 2;
    }
    const t = (crossingSample.altitude - lowSample.altitude) / altDelta;
    return lowTime + (highTime - lowTime) * Math.max(0, Math.min(1, t));
  }

  private getJumpMilliseconds() {
    const setting = Math.max(1, this.jumpSetting);
    if (setting <= 4) {
      return setting * 7 * 24 * 3600 * 1000;
    }

    const monthSteps = setting - 4; // 1 => 1 month, 2 => 2 months, ...
    const months = Math.min(monthSteps, 12);
    return months * 30 * 24 * 3600 * 1000;
  }

  private render(deltaTime: number) {
    this.fadeTrailLayer(this.activeTrail, deltaTime, this.config.trailFade);
    this.surface.clear();
    this.drawGrid();
    this.drawHistoryLayers();
    this.drawActiveTrail();
    this.drawHorizonBand();
    this.drawAxesLabels(this.getLogicalWidth());
    if (this.currentSample && this.isSampleVisible(this.currentSample)) {
      this.drawMarker(this.currentSample);
      this.drawInfo(this.currentSample);
    }
  }

  private drawGrid() {
    const ctx = this.surface.context;
    const height = this.getLogicalHeight();

    ctx.save();
    for (let az = 0; az < 360; az += 30) {
      ctx.beginPath();
      const x = this.mapAzimuth(az);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawMarker(sample: HorizonSample) {
    const ctx = this.surface.context;
    const x = this.mapAzimuth(sample.azimuth);
    const y = this.mapAltitude(sample.altitude);
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawInfo(sample: HorizonSample) {
    const ctx = this.surface.context;
    ctx.save();
    ctx.fillStyle = '#b8b8b8';
    ctx.font = '12px "JetBrains Mono", "Fira Code", monospace';

    const elapsed = this.formatElapsedTime(sample.time);
    const label = [
      `Planet: ${this.config.body}`,
      `Observer: ${this.formatObserver(this.config.observer)}`,
      `Start (UTC): ${this.config.startTime.toISOString().slice(0, 16)}`,
      `Frame (UTC): ${sample.time.toISOString().slice(0, 19)}`,
      `Elapsed: ${elapsed}`,
    ].join('  ·  ');
    ctx.fillText(label, 0, this.getLogicalHeight() - 12);
    ctx.restore();
  }

  private drawAxesLabels(width: number) {
    const ctx = this.surface.context;
    ctx.save();
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '10px "JetBrains Mono", "Fira Code", monospace';
    const azLabels = ['0°', '90°', '180°', '270°'];
    azLabels.forEach((label, index) => {
      const x = this.mapAzimuth(index * 90);
      ctx.fillText(label, x + 4, 12);
    });

    for (let alt = this.altitudeRange.min; alt <= this.altitudeRange.max; alt += 30) {
      const y = this.mapAltitude(alt);
      ctx.fillText(`${alt}°`, width - 36, y - 4);
    }
    ctx.restore();
  }

  private formatObserver(observer: Observer) {
    const latLabel = `${Math.abs(observer.latitude).toFixed(2)}°${observer.latitude >= 0 ? 'N' : 'S'}`;
    const lonLabel = `${Math.abs(observer.longitude).toFixed(2)}°${observer.longitude >= 0 ? 'E' : 'W'}`;
    return `${latLabel} ${lonLabel}`;
  }

  private formatElapsedTime(frameTime: Date) {
    const elapsedMs = frameTime.getTime() - this.config.startTime.getTime();
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) {
      parts.push(`${days}d`);
    }
    parts.push(`${hours.toString().padStart(2, '0')}h`);
    parts.push(`${minutes.toString().padStart(2, '0')}m`);
    parts.push(`${seconds.toString().padStart(2, '0')}s`);
    return parts.join(' ');
  }

  private mapAzimuth(azimuth: number) {
    const normalized = azimuth / 360;
    return normalized * this.getLogicalWidth();
  }

  private mapAltitude(altitude: number) {
    const { min, max } = this.altitudeRange;
    const clamped = Math.max(min, Math.min(max, altitude));
    const ratio = (clamped - min) / (max - min);
    return this.getLogicalHeight() * (1 - ratio);
  }

  private unmapAltitude(y: number) {
    const height = this.getLogicalHeight();
    const { min, max } = this.altitudeRange;
    if (height <= 0) {
      return min;
    }
    const ratio = 1 - y / height;
    const clamped = Math.max(0, Math.min(1, ratio));
    return clamped * (max - min) + min;
  }

  private getLogicalWidth() {
    return this.surface.canvas.width / this.surface.pixelRatio;
  }

  private getLogicalHeight() {
    return this.surface.canvas.height / this.surface.pixelRatio;
  }

  private handleResize = () => {
    this.surface.resize();
    this.syncTrailCanvas(this.activeTrail);
    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;
    this.lastVisibleSample = null;
    this.historyLayers = [];
  };

  private drawHorizonBand() {
    const ctx = this.surface.context;
    const width = this.getLogicalWidth();
    const height = this.getLogicalHeight();
    const base = this.mapAltitude(0);
    const gradientDepth = Math.min(80, this.getLogicalHeight() * 0.15);

    ctx.save();
    ctx.beginPath();
    this.traceHorizonCurve(ctx, width);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = '#070707';
    ctx.fill();
    ctx.restore();

    const glow = ctx.createLinearGradient(0, base - 30, 0, base + gradientDepth);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    glow.addColorStop(0.5, 'rgba(255, 255, 255, 0.18)');
    glow.addColorStop(1, 'rgba(5, 5, 5, 0)');

    ctx.save();
    ctx.beginPath();
    this.traceHorizonCurve(ctx, width);
    const glowBottom = Math.min(height, base + gradientDepth);
    ctx.lineTo(width, glowBottom);
    ctx.lineTo(0, glowBottom);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = glow;
    ctx.fillRect(0, base - 40, width, gradientDepth + 40);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    this.traceHorizonCurve(ctx, width);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private traceHorizonCurve(ctx: CanvasRenderingContext2D, width: number) {
    ctx.moveTo(0, this.getCurvedHorizonY(0));
    const steps = Math.max(24, Math.floor(width / 30));
    const step = width / steps;
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.min(width, i * step);
      ctx.lineTo(x, this.getCurvedHorizonY(x));
    }
  }

  private getCurvedHorizonY(x: number) {
    const width = this.getLogicalWidth();
    const base = this.mapAltitude(0);
    if (width <= 0) {
      return base;
    }

    const amplitude = Math.min(20, this.getLogicalHeight() * 0.03);
    const normalized = x / width;
    return base - Math.sin(normalized * Math.PI) * amplitude;
  }

  private paintSegment(a: HorizonSample, b: HorizonSample, layer: TrailLayer, clampEdges: boolean) {
    const azDelta = Math.abs(b.azimuth - a.azimuth);
    if (azDelta > 180) {
      return;
    }

    // Subdivide segments near the horizon for smoother appearance
    const horizonThreshold = 3; // degrees - subdivide if within this range of horizon
    const needsSubdivision = this.segmentNeedsSubdivision(a, b, horizonThreshold);

    layer.ctx.save();
    layer.ctx.lineWidth = 2;
    layer.ctx.lineJoin = 'round';
    layer.ctx.lineCap = 'round';
    layer.ctx.strokeStyle = '#e5e5e5';
    layer.ctx.beginPath();

    if (needsSubdivision || clampEdges) {
      this.paintSubdividedSegment(a, b, layer, clampEdges);
    } else {
      const start = this.toCanvasPoint(a);
      const end = this.toCanvasPoint(b);
      layer.ctx.moveTo(start.x, start.y);
      layer.ctx.lineTo(end.x, end.y);
    }

    layer.ctx.stroke();
    layer.ctx.restore();

    if (layer === this.activeTrail) {
      this.activeHasPaint = true;
    }
  }

  private segmentNeedsSubdivision(a: HorizonSample, b: HorizonSample, threshold: number): boolean {
    const cutoffA = this.getHorizonCutoffForAzimuth(a.azimuth);
    const cutoffB = this.getHorizonCutoffForAzimuth(b.azimuth);
    const distA = Math.abs(a.altitude - cutoffA);
    const distB = Math.abs(b.altitude - cutoffB);
    return distA < threshold || distB < threshold;
  }

  private paintSubdividedSegment(
    a: HorizonSample,
    b: HorizonSample,
    layer: TrailLayer,
    clipToHorizon: boolean,
  ) {
    const subdivisions = 16; // Increased for smoother curves
    let firstPoint = true;
    let lastWasBelow = false;

    for (let i = 0; i <= subdivisions; i += 1) {
      const t = i / subdivisions;
      const interpolated = interpolateSample(a, b, t);
      const cutoff = this.getHorizonCutoffForAzimuth(interpolated.azimuth);
      const isBelow = interpolated.altitude < cutoff;

      if (clipToHorizon && isBelow) {
        // If transitioning from above to below, draw to horizon crossing first
        if (!lastWasBelow && !firstPoint && i > 0) {
          const prevT = (i - 1) / subdivisions;
          const prevInterpolated = interpolateSample(a, b, prevT);
          const crossingPoint = this.findHorizonCrossingBetweenPoints(prevInterpolated, interpolated);
          const crossingCanvas = this.toCanvasPoint(crossingPoint);
          layer.ctx.lineTo(crossingCanvas.x, crossingCanvas.y);
        }
        lastWasBelow = true;
        firstPoint = true;
        continue;
      }

      // If transitioning from below to above, start at horizon crossing
      if (!isBelow && lastWasBelow && i > 0) {
        const prevT = (i - 1) / subdivisions;
        const prevInterpolated = interpolateSample(a, b, prevT);
        const crossingPoint = this.findHorizonCrossingBetweenPoints(prevInterpolated, interpolated);
        const crossingCanvas = this.toCanvasPoint(crossingPoint);
        layer.ctx.moveTo(crossingCanvas.x, crossingCanvas.y);
        firstPoint = false;
      }

      const canvasPoint = this.toCanvasPoint(interpolated);

      if (firstPoint) {
        layer.ctx.moveTo(canvasPoint.x, canvasPoint.y);
        firstPoint = false;
      } else {
        layer.ctx.lineTo(canvasPoint.x, canvasPoint.y);
      }

      lastWasBelow = isBelow;
    }
  }

  private findHorizonCrossingBetweenPoints(
    below: SamplePoint,
    above: SamplePoint,
  ): SamplePoint {
    const cutoffBelow = this.getHorizonCutoffForAzimuth(below.azimuth);
    const cutoffAbove = this.getHorizonCutoffForAzimuth(above.azimuth);

    const altDelta = above.altitude - below.altitude;
    const cutoffDelta = cutoffAbove - cutoffBelow;
    const numerator = cutoffBelow - below.altitude;
    const denominator = altDelta - cutoffDelta;

    let t = 0.5;
    if (Math.abs(denominator) > 1e-6) {
      t = numerator / denominator;
      t = Math.max(0, Math.min(1, t));
    }

    const crossingAzimuth = interpolateAzimuth(below.azimuth, above.azimuth, t);
    const crossingAltitude = below.altitude + altDelta * t;

    return {
      azimuth: crossingAzimuth,
      altitude: crossingAltitude,
    };
  }

  private commitActiveTrailToHistory() {
    if (!this.activeHasPaint) {
      return false;
    }

    const snapshot = cloneCanvas(this.activeTrail.canvas);
    this.historyLayers = this.historyLayers
      .map((layer) => ({ ...layer, age: layer.age + 1 }))
      .filter((layer) => layer.age < this.historyPersistence);
    this.historyLayers.push({ canvas: snapshot, age: 0 });
    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;
    this.lastVisibleSample = null;
    return true;
  }

  private fadeTrailLayer(layer: TrailLayer, deltaTime: number, fadeRate: number) {
    if (deltaTime <= 0 || fadeRate <= 0) {
      return;
    }

    const alpha = 1 - Math.exp(-fadeRate * (deltaTime / 1000));
    if (alpha <= 0) {
      return;
    }

    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'destination-out';
    layer.ctx.globalAlpha = Math.min(1, alpha);
    layer.ctx.fillStyle = '#000000';
    layer.ctx.fillRect(0, 0, this.getLogicalWidth(), this.getLogicalHeight());
    layer.ctx.restore();
  }

  private drawHistoryLayers() {
    const ctx = this.surface.context;
    const width = this.getLogicalWidth();
    const height = this.getLogicalHeight();
    this.historyLayers = this.historyLayers.filter((layer) => layer.age < this.historyPersistence);

    this.historyLayers.forEach((layer) => {
      const alpha = Math.max(0, 1 - layer.age / this.historyPersistence);
      if (alpha <= 0) {
        return;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(layer.canvas, 0, 0, layer.canvas.width, layer.canvas.height, 0, 0, width, height);
      ctx.restore();
    });
  }

  private drawActiveTrail() {
    const ctx = this.surface.context;
    ctx.drawImage(
      this.activeTrail.canvas,
      0,
      0,
      this.activeTrail.canvas.width,
      this.activeTrail.canvas.height,
      0,
      0,
      this.getLogicalWidth(),
      this.getLogicalHeight(),
    );
  }

  private completeCycle() {
    if (this.commitActiveTrailToHistory()) {
      this.completedCycles += 1;
      if (this.cycleLimit > 0 && this.completedCycles >= this.cycleLimit) {
        this.restartSimulation();
      }
    }
  }

  private restartSimulation() {
    this.simTimeMs = 0;
    this.remainderMs = 0;
    this.currentSample = null;
    this.lastVisibleSample = null;
    this.lastVisibleTimeMs = 0;
    this.activeHasPaint = false;
    this.historyLayers = [];
    this.completedCycles = 0;
    clearTrailLayer(this.activeTrail);
  }

  private syncTrailCanvas(layer: TrailLayer) {
    const width = Math.max(1, Math.floor(this.getLogicalWidth()));
    const height = Math.max(1, Math.floor(this.getLogicalHeight()));
    const ratio = this.surface.pixelRatio;
    const pixelWidth = width * ratio;
    const pixelHeight = height * ratio;

    if (layer.canvas.width !== pixelWidth || layer.canvas.height !== pixelHeight) {
      layer.canvas.width = pixelWidth;
      layer.canvas.height = pixelHeight;
      layer.canvas.style.width = `${width}px`;
      layer.canvas.style.height = `${height}px`;
    }

    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.scale(ratio, ratio);
  }

  private toCanvasPoint(point: SamplePoint) {
    return {
      x: this.mapAzimuth(point.azimuth),
      y: this.mapAltitude(point.altitude),
    };
  }

  private isSampleVisible(sample: HorizonSample) {
    const cutoff = this.getHorizonCutoffForAzimuth(sample.azimuth);
    return sample.altitude >= cutoff;
  }

  private getHorizonCutoffForAzimuth(azimuth: number) {
    if (!this.config.autoHorizon) {
      return this.config.horizonCutoff;
    }
    return this.getCurvedHorizonAltitudeAtAzimuth(azimuth);
  }

  private getCurvedHorizonAltitudeAtAzimuth(azimuth: number) {
    const x = this.mapAzimuth(azimuth);
    const y = this.getCurvedHorizonY(x);
    return this.unmapAltitude(y);
  }
}

/** Trail layer helpers */
type TrailLayer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
type HistoryLayer = { canvas: HTMLCanvasElement; age: number };

const createTrailLayer = (): TrailLayer => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to create trail context');
  }
  return { canvas, ctx };
};

const clearTrailLayer = (layer: TrailLayer) => {
  layer.ctx.save();
  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  layer.ctx.restore();
};

const cloneCanvas = (source: HTMLCanvasElement) => {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.style.width = source.style.width;
  canvas.style.height = source.style.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to clone canvas');
  }
  ctx.drawImage(source, 0, 0);
  return canvas;
};

const lerp = (start: number, end: number, t: number) => start + (end - start) * t;

const interpolateAzimuth = (start: number, end: number, t: number) => {
  const delta = ((((end - start) % 360) + 540) % 360) - 180;
  return wrapAngle(start + delta * t);
};

const wrapAngle = (value: number) => {
  let angle = value % 360;
  if (angle < 0) {
    angle += 360;
  }
  return angle;
};

const interpolateSample = (a: HorizonSample, b: HorizonSample, t: number): SamplePoint => ({
  azimuth: interpolateAzimuth(a.azimuth, b.azimuth, t),
  altitude: lerp(a.altitude, b.altitude, t),
});
