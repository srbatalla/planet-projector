import { Body, HelioVector, Ecliptic } from 'astronomy-engine';
import { CanvasSurface } from '../../render/canvas';
import { getPlanetColor } from '../horizon/planetColors';
import { type SpecialObject } from '../../core/specialObjects';

type SpirographConfig = {
  bodies: Body[];
  startTime: Date;
  sampleMinutes: number;
  playbackSpeed: number;
  perspectiveBody: Body;
  special: SpecialObject | null;
};

type TraceSample = {
  x: number;
  y: number;
  radius: number;
  time: Date;
};

type Trace = {
  targetType: 'planet' | 'special';
  body: Body | null;
  special: SpecialObject | null;
  color: string;
  samples: TraceSample[];
  maxRadius: number;
  currentSample: TraceSample | null;
  previewSample: TraceSample | null;
};

export class SpirographView {
  private surface: CanvasSurface;
  private animationHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private readonly stepMs: number;
  private readonly baseTimestamp: number;
  private simTimeMs = 0;
  private remainderMs = 0;
  private traces: Trace[] = [];
  private readonly traceMap = new Map<Body, Trace>();
  private resizeListenerAttached = false;
  private playbackSpeed = 1;
  private readonly perspectiveBody: Body;
  private readonly specialTrace: Trace | null;

  constructor(private container: HTMLElement, private config: SpirographConfig) {
    this.stepMs = Math.max(1, this.config.sampleMinutes * 60 * 1000);
    this.baseTimestamp = this.config.startTime.getTime();
    this.perspectiveBody = this.config.perspectiveBody;

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.container.appendChild(canvas);

    this.surface = new CanvasSurface(canvas);
    this.specialTrace = this.config.special
      ? this.createSpecialTrace(this.config.special)
      : null;
    this.syncTraces(this.config.bodies);
    this.updatePlaybackSpeed(this.config.playbackSpeed);
  }

  start() {
    if (this.animationHandle !== null) {
      return;
    }

    if (!this.resizeListenerAttached) {
      window.addEventListener('resize', this.handleResize, { passive: true });
      this.resizeListenerAttached = true;
    }

    this.animationHandle = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }

    if (this.resizeListenerAttached) {
      window.removeEventListener('resize', this.handleResize);
      this.resizeListenerAttached = false;
    }
  }

  updatePlaybackSpeed(newSpeed: number) {
    if (!Number.isFinite(newSpeed) || newSpeed <= 0) {
      this.playbackSpeed = Number.POSITIVE_INFINITY;
      this.config.playbackSpeed = this.playbackSpeed;
      return;
    }
    this.playbackSpeed = Math.max(1, newSpeed);
    this.config.playbackSpeed = this.playbackSpeed;
  }

  updatePlanets(newBodies: Body[]) {
    const unique = Array.from(new Set(newBodies)).filter((body) => body !== this.perspectiveBody);
    this.config.bodies = unique;
    this.syncTraces(unique);
  }

  private syncTraces(bodies: Body[]) {
    const existing = new Map(this.traceMap);
    this.traces = [];
    this.traceMap.clear();
    for (const body of bodies) {
      if (body === this.perspectiveBody) {
        continue;
      }
      const kept = existing.get(body) ?? this.createTrace(body);
      this.traces.push(kept);
      this.traceMap.set(body, kept);
    }

    for (const [body, trace] of existing.entries()) {
      if (!this.traceMap.has(body)) {
        trace.samples.length = 0;
        trace.maxRadius = 0;
        trace.currentSample = null;
        trace.previewSample = null;
      }
    }

    if (this.specialTrace) {
      this.traces.push(this.specialTrace);
    }
  }

  private createTrace(body: Body): Trace {
    return {
      targetType: 'planet',
      body,
      special: null,
      color: getPlanetColor(body),
      samples: [],
      maxRadius: 0,
      currentSample: null,
      previewSample: null,
    };
  }

  private createSpecialTrace(special: SpecialObject): Trace {
    return {
      targetType: 'special',
      body: null,
      special,
      color: special.color,
      samples: [],
      maxRadius: 0,
      currentSample: null,
      previewSample: null,
    };
  }

  private loop = (timestamp: number) => {
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
    }

    const deltaTime = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;

    const deltaSimMs = Number.isFinite(this.playbackSpeed)
      ? deltaTime * this.playbackSpeed
      : deltaTime * 1000;
    this.advanceSimulation(deltaSimMs);
    this.render();
    this.animationHandle = requestAnimationFrame(this.loop);
  };

  private handleResize = () => {
    this.surface.resize();
  };

  private advanceSimulation(deltaSimMs: number) {
    if (deltaSimMs <= 0 || this.traces.length === 0) {
      return;
    }

    if (!Number.isFinite(this.playbackSpeed)) {
      this.runMaxSpeedLoop();
      return;
    }

    this.remainderMs += deltaSimMs;
    const steps = Math.floor(this.remainderMs / this.stepMs);
    for (let i = 0; i < steps; i += 1) {
      this.remainderMs -= this.stepMs;
      this.processStep(this.stepMs);
    }
  }

  private runMaxSpeedLoop() {
    const budgetMs = 12;
    const start = performance.now();
    let iterations = 0;
    const maxIterations = 30000;

    while (iterations < maxIterations && performance.now() - start < budgetMs) {
      this.processStep(this.stepMs);
      iterations += 1;
    }
  }

  private processStep(stepMs: number) {
    this.simTimeMs += stepMs;
    const sampleTime = new Date(this.baseTimestamp + this.simTimeMs);

    for (const trace of this.traces) {
      const sample = this.computeSample(trace, sampleTime);
      trace.currentSample = sample;
      trace.previewSample = sample;
      trace.samples.push(sample);
      if (sample.radius > trace.maxRadius) {
        trace.maxRadius = sample.radius;
      }
    }
  }

  private computeSample(trace: Trace, time: Date): TraceSample {
    const target =
      trace.targetType === 'planet'
        ? this.getEclipticVector(trace.body as Body, time)
        : this.getSpecialVector(trace.special!, time);
    const reference = this.getEclipticVector(this.perspectiveBody, time);
    const x = target.x - reference.x;
    const y = target.y - reference.y;
    const radius = Math.hypot(x, y);
    return { x, y, radius, time };
  }

  private getEclipticVector(body: Body, time: Date) {
    if (body === Body.Sun) {
      return { x: 0, y: 0, z: 0 };
    }
    const helio = HelioVector(body, time);
    const ecliptic = Ecliptic(helio);
    return ecliptic.vec;
  }

  private getSpecialVector(special: SpecialObject, time: Date) {
    // Placeholder: treat special as stationary for now
    return { x: 0, y: 0, z: 0 };
  }

  private render() {
    const width = this.surface.canvas.width / this.surface.pixelRatio;
    const height = this.surface.canvas.height / this.surface.pixelRatio;
    this.surface.clear();

    this.updatePreviewSamples();
    const scale = this.computeScale(width, height);
    this.drawReferenceFrame(width, height);

    for (const trace of this.traces) {
      this.drawTrace(trace, scale, width, height);
      this.drawPreviewExtension(trace, scale, width, height);
    }

    for (const trace of this.traces) {
      this.drawMarker(trace, scale, width, height);
    }

    this.drawInfo(width, height);
  }

  private updatePreviewSamples() {
    if (this.traces.length === 0) {
      return;
    }
    const previewTime = new Date(this.baseTimestamp + this.simTimeMs + this.remainderMs);
    for (const trace of this.traces) {
      trace.previewSample = this.computeSample(trace, previewTime);
    }
  }

  private computeScale(width: number, height: number) {
    const targetRadius = 0.45 * Math.min(width, height);
    let maxRadius = 0;
    for (const trace of this.traces) {
      if (trace.maxRadius > maxRadius) {
        maxRadius = trace.maxRadius;
      }
    }

    if (maxRadius <= 0 || !Number.isFinite(maxRadius)) {
      return targetRadius || 1;
    }

    return targetRadius / maxRadius;
  }

  private drawReferenceFrame(width: number, height: number) {
    const ctx = this.surface.context;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 0.45 * Math.min(width, height);
    const rings = 5;

    ctx.save();
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;

    ctx.beginPath();
    ctx.moveTo(centerX - radius, centerY);
    ctx.lineTo(centerX + radius, centerY);
    ctx.moveTo(centerX, centerY - radius);
    ctx.lineTo(centerX, centerY + radius);
    ctx.stroke();

    for (let i = 1; i <= rings; i += 1) {
      const r = (i / rings) * radius;
      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawTrace(trace: Trace, scale: number, width: number, height: number) {
    if (trace.samples.length < 2) {
      return;
    }

    const ctx = this.surface.context;
    const centerX = width / 2;
    const centerY = height / 2;
    ctx.save();
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();

    for (let i = 0; i < trace.samples.length; i += 1) {
      const sample = trace.samples[i];
      const canvasPoint = this.toCanvasPoint(sample, centerX, centerY, scale);
      if (i === 0) {
        ctx.moveTo(canvasPoint.x, canvasPoint.y);
      } else {
        ctx.lineTo(canvasPoint.x, canvasPoint.y);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  private drawMarker(trace: Trace, scale: number, width: number, height: number) {
    const markerSample = trace.previewSample ?? trace.currentSample;
    if (!markerSample) {
      return;
    }

    const ctx = this.surface.context;
    const { x, y } = this.toCanvasPoint(markerSample, width / 2, height / 2, scale);

    ctx.save();
    ctx.fillStyle = trace.color;
    ctx.shadowColor = trace.color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawInfo(width: number, height: number) {
    const ctx = this.surface.context;
    ctx.save();
    ctx.font = '12px "JetBrains Mono", "Fira Code", monospace';
    ctx.fillStyle = '#dcdcdc';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const padding = 12;

    let label = 'No planets selected';
    if (this.traces.length > 0) {
      const firstTrace = this.traces[0];
      const refSample = firstTrace.previewSample ?? firstTrace.currentSample;
      const frameTime = refSample?.time ?? new Date(this.baseTimestamp + this.simTimeMs);
      const elapsed = this.formatElapsedTime(frameTime.getTime() - this.baseTimestamp);
      label = [
        `Planets: ${this.traces.map((t) => t.body).join(', ')}`,
        `Start (UTC): ${new Date(this.baseTimestamp).toISOString().slice(0, 16)}`,
        `Frame (UTC): ${frameTime.toISOString().slice(0, 19)}`,
        `Elapsed: ${elapsed}`,
      ].join('  ·  ');
    }

    ctx.fillText(label, padding, padding);
    ctx.restore();
  }

  private drawPreviewExtension(trace: Trace, scale: number, width: number, height: number) {
    if (!trace.currentSample || !trace.previewSample) {
      return;
    }

    const ctx = this.surface.context;
    const centerX = width / 2;
    const centerY = height / 2;
    const start = this.toCanvasPoint(trace.currentSample, centerX, centerY, scale);
    const end = this.toCanvasPoint(trace.previewSample, centerX, centerY, scale);
    ctx.save();
    ctx.strokeStyle = trace.color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
  }

  private toCanvasPoint(sample: TraceSample, centerX: number, centerY: number, scale: number) {
    return {
      x: centerX + sample.x * scale,
      y: centerY - sample.y * scale,
    };
  }

  private formatElapsedTime(elapsedMs: number) {
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
}
