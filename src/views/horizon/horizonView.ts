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
  jumpSetting: number;
  trailPersistence: number;
  cycleLimit: number;
  activeFadeRate: number;
  azimuthCheckpointInterval: number;
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
  // Pre-calculated constants for performance
  private readonly AZIMUTH_TO_NORMALIZED = 1 / 360;
  private readonly altitudeScale: number;
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
  private staticLayerSize = { width: 0, height: 0 };
  private gridLayer: HTMLCanvasElement | null = null;
  private horizonLayer: HTMLCanvasElement | null = null;
  private historyCanvasPool: HTMLCanvasElement[] = [];
  private lastAzimuthCheckpoint = 0;
  private cycleStartAzimuth = 0;
  private azimuthAgeThisCycle = 0; // Track how much we've aged from azimuth this cycle
  // Cached dimensions for performance (avoid repeated calculations)
  private cachedLogicalWidth = 0;
  private cachedLogicalHeight = 0;
  // Pruning optimization - only prune every N frames
  private pruneFrameCounter = 0;
  private readonly PRUNE_INTERVAL = 10;
  // Reusable Date object to avoid allocations
  private readonly reusableDate = new Date();

  constructor(private container: HTMLElement, private config: HorizonViewConfig) {
    this.stepMs = Math.max(1, this.config.sampleMinutes * 60 * 1000);
    this.baseTimestamp = this.config.startTime.getTime();
    this.altitudeScale = 1 / (this.altitudeRange.max - this.altitudeRange.min);

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.container.appendChild(canvas);

    this.surface = new CanvasSurface(canvas);
    this.jumpSetting = this.config.jumpSetting;
    this.historyPersistence = Math.max(1, this.config.trailPersistence);
    this.cycleLimit = Math.max(0, this.config.cycleLimit);

    // Update dimension cache BEFORE using it in other methods
    this.updateDimensionCache();
    this.syncTrailCanvas(this.activeTrail);
    this.ensureStaticLayers();
    clearTrailLayer(this.activeTrail);

    window.addEventListener('resize', this.handleResize, { passive: true });
  }

  start() {
    if (this.animationHandle !== null) {
      return;
    }

    // Initialize: if starting with a visible planet, find the arc entry point
    const initialSample = this.computeSampleAt(this.simTimeMs);
    if (this.isSampleDrawable(initialSample)) {
      const entryPoint = this.findArcEntryPoint(this.simTimeMs);
      this.simTimeMs = entryPoint.timeMs;
      this.lastVisibleSample = entryPoint.sample;
      this.lastVisibleTimeMs = entryPoint.timeMs;
    }

    this.animationHandle = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
  }

  updatePlaybackSpeed(newSpeed: number) {
    this.config.playbackSpeed = Math.max(1, newSpeed);
  }

  private loop = (timestamp: number) => {
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
    }

    const deltaTime = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;

    const deltaSimMs = deltaTime * this.config.playbackSpeed;
    this.advanceSimulation(deltaSimMs);
    this.render(deltaTime, deltaSimMs); // Pass both real and simulation time
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

    // Update current sample for marker display
    const previewTime = this.simTimeMs + this.remainderMs;
    const previewSample = this.computeSampleAt(previewTime);
    this.currentSample = this.isSampleVisible(previewSample) ? previewSample : null;
  }

  private processStep(stepMs: number) {
    this.simTimeMs += stepMs;

    const sample = this.computeSampleAt(this.simTimeMs);
    const isDrawable = this.isSampleDrawable(sample);
    const isVisible = this.isSampleVisible(sample);

    // If too far below horizon, skip ahead
    if (!isDrawable) {
      if (this.lastVisibleSample) {
        this.completeCycle();
        this.lastVisibleSample = null;
      }

      const nextVisible = this.seekNextVisibleSample(this.simTimeMs);
      if (!nextVisible) {
        this.currentSample = null;
        return;
      }

      this.simTimeMs = nextVisible.timeMs;
      this.remainderMs = 0;
      this.currentSample = nextVisible.sample;
      return;
    }

    // Draw segment even if slightly below horizon - horizon band will occlude it
    if (this.lastVisibleSample) {
      this.paintSegment(this.lastVisibleSample, sample, this.activeTrail);
    }

    this.lastVisibleSample = sample;
    this.lastVisibleTimeMs = this.simTimeMs;
    this.currentSample = isVisible ? sample : null; // Only show marker if truly visible
  }

  private computeSampleAt(simTimeMs: number): HorizonSample {
    this.reusableDate.setTime(this.baseTimestamp + simTimeMs);
    return computeHorizonPoint({
      body: this.config.body,
      observer: this.config.observer,
      time: this.reusableDate,
    });
  }

  private seekNextVisibleSample(fromTimeMs: number) {
    const jumpMs = this.getJumpMilliseconds();
    const maxIterations = Math.ceil(
      (MAX_LOOKAHEAD_HOURS * 3600 * 1000) / Math.max(1, this.stepMs),
    );

    let timeMs = fromTimeMs + jumpMs;
    for (let i = 0; i < maxIterations; i += 1) {
      const sample = this.computeSampleAt(timeMs);
      if (this.isSampleDrawable(sample)) {
        // Found a drawable sample - now search backward to find the actual entry point
        const entryPoint = this.findArcEntryPoint(timeMs);
        this.lastVisibleSample = null;
        this.activeHasPaint = false;
        // Reset azimuth checkpoint to prevent jolt when warping to new horizon
        this.lastAzimuthCheckpoint = entryPoint.sample.azimuth;
        this.cycleStartAzimuth = entryPoint.sample.azimuth;
        return entryPoint;
      }

      // Adaptive stepping: if very far below horizon, jump faster
      const cutoff = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
      const depthBelowHorizon = cutoff - sample.altitude;
      let adaptiveStep = this.stepMs;

      if (depthBelowHorizon > 30) {
        // Very deep below horizon - jump 6 hours
        adaptiveStep = 6 * 3600 * 1000;
      } else if (depthBelowHorizon > 15) {
        // Moderately deep - jump 2 hours
        adaptiveStep = 2 * 3600 * 1000;
      } else if (depthBelowHorizon > 5) {
        // Somewhat below - jump 30 minutes
        adaptiveStep = 30 * 60 * 1000;
      }

      timeMs += adaptiveStep;
    }

    return null;
  }

  private findArcEntryPoint(foundTimeMs: number): { sample: HorizonSample; timeMs: number } {
    // Two-phase search: coarse then fine
    // Phase 1: Coarse search backward with 30-minute steps
    const coarseStepMs = 30 * 60 * 1000;
    let timeMs = foundTimeMs;
    let lastDrawable: { sample: HorizonSample; timeMs: number } | null = null;

    // Coarse search back up to 12 hours
    const maxCoarseSteps = Math.ceil((12 * 3600 * 1000) / coarseStepMs);
    for (let i = 0; i < maxCoarseSteps; i += 1) {
      const sample = this.computeSampleAt(timeMs);
      if (!this.isSampleDrawable(sample)) {
        // Found boundary in coarse search - now refine
        break;
      }
      lastDrawable = { sample, timeMs };
      timeMs -= coarseStepMs;
    }

    if (!lastDrawable) {
      return { sample: this.computeSampleAt(foundTimeMs), timeMs: foundTimeMs };
    }

    // Phase 2: Fine search forward from last coarse position
    const fineStepMs = Math.min(this.stepMs, 5 * 60 * 1000);
    timeMs = lastDrawable.timeMs;
    const endTimeMs = lastDrawable.timeMs + coarseStepMs;

    for (; timeMs <= endTimeMs; timeMs += fineStepMs) {
      const sample = this.computeSampleAt(timeMs);
      if (this.isSampleDrawable(sample)) {
        return { sample, timeMs };
      }
    }

    return lastDrawable;
  }

  private getJumpMilliseconds() {
    const setting = Math.max(1, this.jumpSetting);

    // Setting 1: "None" - don't jump, just step forward
    if (setting === 1) {
      return this.stepMs;
    }

    // Setting 2: "Next" - no initial jump, use adaptive seeking only
    if (setting === 2) {
      return 0;
    }

    // Settings 3-6: 1-4 weeks
    if (setting <= 6) {
      const weeks = setting - 2;
      return weeks * 7 * 24 * 3600 * 1000;
    }

    // Settings 7-12: 1-6 months
    const monthSteps = setting - 6;
    const months = Math.min(monthSteps, 12);
    return months * 30 * 24 * 3600 * 1000;
  }

  private render(deltaTime: number, deltaSimMs: number) {
    // Fade active trail based on simulation time (scales with playback speed)
    this.fadeTrailLayer(this.activeTrail, deltaSimMs, this.config.activeFadeRate);
    this.ageHistoryLayersByAzimuth();

    this.surface.clear();
    this.blitStaticLayer(this.gridLayer, 'grid');
    this.drawHistoryLayers();
    this.drawActiveTrail();
    this.blitStaticLayer(this.horizonLayer, 'horizon');
    this.drawAxesLabels(this.getLogicalWidth());

    // Always draw info background to prevent flashing
    this.drawInfo(this.currentSample);

    // Only draw marker when planet is visible
    if (this.currentSample && this.isSampleVisible(this.currentSample)) {
      this.drawMarker(this.currentSample);
    }
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

  private drawInfo(sample: HorizonSample | null) {
    const ctx = this.surface.context;
    const height = this.getLogicalHeight();

    ctx.save();
    ctx.font = '12px "JetBrains Mono", "Fira Code", monospace';

    const textY = height - 12;
    const padding = 8;

    // Build info text
    let label: string;
    if (sample && this.isSampleVisible(sample)) {
      const elapsed = this.formatElapsedTime(sample.time);
      label = [
        `Planet: ${this.config.body}`,
        `Observer: ${this.formatObserver(this.config.observer)}`,
        `Start (UTC): ${this.config.startTime.toISOString().slice(0, 16)}`,
        `Frame (UTC): ${sample.time.toISOString().slice(0, 19)}`,
        `Elapsed: ${elapsed}`,
      ].join('  ·  ');
    } else {
      // Show static info when planet not visible
      label = [
        `Planet: ${this.config.body}`,
        `Observer: ${this.formatObserver(this.config.observer)}`,
        `Start (UTC): ${this.config.startTime.toISOString().slice(0, 16)}`,
        'Waiting for next visible arc...',
      ].join('  ·  ');
    }

    // Draw text with shadow for visibility over horizon gradient
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(label, padding, textY);
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
    return azimuth * this.AZIMUTH_TO_NORMALIZED * this.cachedLogicalWidth;
  }

  private mapAltitude(altitude: number) {
    const { min, max } = this.altitudeRange;
    const clamped = Math.max(min, Math.min(max, altitude));
    const ratio = (clamped - min) * this.altitudeScale;
    return this.cachedLogicalHeight * (1 - ratio);
  }

  private unmapAltitude(y: number) {
    const height = this.cachedLogicalHeight;
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

  private updateDimensionCache() {
    this.cachedLogicalWidth = this.getLogicalWidth();
    this.cachedLogicalHeight = this.getLogicalHeight();
  }

  private handleResize = () => {
    this.surface.resize();
    this.updateDimensionCache();
    this.syncTrailCanvas(this.activeTrail);
    this.ensureStaticLayers(true);
    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;
    this.lastVisibleSample = null;
    for (let i = 0; i < this.historyLayers.length; i++) {
      this.releaseHistoryCanvas(this.historyLayers[i].canvas);
    }
    this.historyLayers = [];
  };

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
    const width = this.cachedLogicalWidth;
    const base = this.mapAltitude(0);
    if (width <= 0) {
      return base;
    }

    const amplitude = Math.min(20, this.cachedLogicalHeight * 0.03);
    const normalized = x / width;
    return base - Math.sin(normalized * Math.PI) * amplitude;
  }

  private paintSegment(a: HorizonSample, b: HorizonSample, layer: TrailLayer) {
    const azDelta = Math.abs(b.azimuth - a.azimuth);
    if (azDelta > 180) {
      return; // Avoid wrapping artifacts
    }

    const start = this.toCanvasPoint(a);
    const end = this.toCanvasPoint(b);

    layer.ctx.save();
    layer.ctx.lineWidth = 2;
    layer.ctx.lineJoin = 'round';
    layer.ctx.lineCap = 'round';
    layer.ctx.strokeStyle = '#e5e5e5';
    layer.ctx.beginPath();
    layer.ctx.moveTo(start.x, start.y);
    layer.ctx.lineTo(end.x, end.y);
    layer.ctx.stroke();
    layer.ctx.restore();

    if (layer === this.activeTrail) {
      this.activeHasPaint = true;
    }
  }

  private commitActiveTrailToHistory() {
    if (!this.activeHasPaint) {
      return false;
    }

    const completionBonus = Math.max(0, 1 - this.azimuthAgeThisCycle);
    this.pruneHistoryLayers();

    // Newly completed stroke starts with whatever fraction of the cycle remained
    const snapshot = this.acquireHistoryCanvas();
    const ctx = snapshot.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, snapshot.width, snapshot.height);
      ctx.drawImage(
        this.activeTrail.canvas,
        0,
        0,
        this.activeTrail.canvas.width,
        this.activeTrail.canvas.height,
        0,
        0,
        snapshot.width,
        snapshot.height,
      );
    }
    this.historyLayers.push({ canvas: snapshot, age: completionBonus });

    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;

    const completedSample = this.lastVisibleSample;
    this.lastVisibleSample = null;

    // Reset for new cycle
    this.azimuthAgeThisCycle = 0;
    if (completedSample) {
      this.lastAzimuthCheckpoint = completedSample.azimuth;
      this.cycleStartAzimuth = completedSample.azimuth;
    }

    return true;
  }

  private ageHistoryLayersByAzimuth() {
    // Only age when we're actively painting - prevents jolts during horizon transitions
    if (!this.lastVisibleSample || this.historyLayers.length === 0 || !this.activeHasPaint) {
      return;
    }

    const currentAzimuth = this.lastVisibleSample.azimuth;

    // Calculate angular distance, handling 0°/360° wraparound
    let azimuthDelta = currentAzimuth - this.lastAzimuthCheckpoint;
    if (azimuthDelta > 180) {
      azimuthDelta -= 360;
    } else if (azimuthDelta < -180) {
      azimuthDelta += 360;
    }

    const absAzimuthDelta = Math.abs(azimuthDelta);

    // Check if we've crossed a checkpoint threshold
    if (absAzimuthDelta >= this.config.azimuthCheckpointInterval) {
      // Calculate how many checkpoints we crossed
      const checkpointsCrossed = Math.floor(absAzimuthDelta / this.config.azimuthCheckpointInterval);

      // Age increment: full sweep (360°) = 1 age unit
      // So 10° checkpoint = 10/360 ≈ 0.0278 age units
      const ageIncrement = (checkpointsCrossed * this.config.azimuthCheckpointInterval) / 360;

      // Age all historical layers
      for (let i = 0; i < this.historyLayers.length; i++) {
        this.historyLayers[i].age += ageIncrement;
      }

      // Track total azimuth aging for this cycle
      this.azimuthAgeThisCycle += ageIncrement;

      // Update checkpoint
      this.lastAzimuthCheckpoint = currentAzimuth;
    }
  }

  private fadeTrailLayer(layer: TrailLayer, deltaSimMs: number, fadeRate: number) {
    if (deltaSimMs <= 0 || fadeRate <= 0) {
      return;
    }

    // Fade based on simulation time (scales with playback speed)
    // Use uncapped simulation time to ensure consistent trail length across all playback speeds
    const simSeconds = deltaSimMs / 1000;
    const alpha = 1 - Math.exp(-fadeRate * simSeconds);

    if (alpha <= 0) {
      return;
    }

    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'destination-out';
    layer.ctx.globalAlpha = Math.min(1, alpha);
    layer.ctx.fillStyle = '#000000';
    layer.ctx.fillRect(0, 0, this.cachedLogicalWidth, this.cachedLogicalHeight);
    layer.ctx.restore();
  }

  private drawHistoryLayers() {
    const ctx = this.surface.context;
    const width = this.cachedLogicalWidth;
    const height = this.cachedLogicalHeight;

    // Only prune every N frames to reduce overhead
    if (++this.pruneFrameCounter >= this.PRUNE_INTERVAL) {
      this.pruneHistoryLayers();
      this.pruneFrameCounter = 0;
    }

    for (let i = 0; i < this.historyLayers.length; i++) {
      const layer = this.historyLayers[i];
      // Auto-fade based on age: stays bright longer, fades quickly at end
      // Using inverse quadratic: 1 - x² keeps values high initially
      const ageRatio = layer.age / this.historyPersistence;
      const alpha = 1 - Math.pow(ageRatio, 2);

      // Skip layers that are nearly invisible (performance optimization)
      if (alpha <= 0.01) {
        continue;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(layer.canvas, 0, 0, layer.canvas.width, layer.canvas.height, 0, 0, width, height);
      ctx.restore();
    }
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
      this.cachedLogicalWidth,
      this.cachedLogicalHeight,
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

  private pruneHistoryLayers() {
    // Use reverse iteration with splice for in-place filtering (avoids creating new array)
    for (let i = this.historyLayers.length - 1; i >= 0; i--) {
      if (this.historyLayers[i].age >= this.historyPersistence) {
        this.releaseHistoryCanvas(this.historyLayers[i].canvas);
        this.historyLayers.splice(i, 1);
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
    for (let i = 0; i < this.historyLayers.length; i++) {
      this.releaseHistoryCanvas(this.historyLayers[i].canvas);
    }
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

  private ensureStaticLayers(force = false) {
    const width = Math.max(1, Math.floor(this.getLogicalWidth()));
    const height = Math.max(1, Math.floor(this.getLogicalHeight()));
    if (!force && this.staticLayerSize.width === width && this.staticLayerSize.height === height) {
      return;
    }

    this.staticLayerSize = { width, height };
    this.gridLayer = this.createOrResizeStaticLayer(this.gridLayer, width, height);
    this.horizonLayer = this.createOrResizeStaticLayer(this.horizonLayer, width, height);
    if (this.gridLayer) {
      this.renderGridLayer(this.gridLayer.getContext('2d')!, width, height);
    }
    if (this.horizonLayer) {
      this.renderHorizonLayer(this.horizonLayer.getContext('2d')!, width, height);
    }
    // Drop pool so reused canvases match new resolution
    this.historyCanvasPool = [];
  }

  private createOrResizeStaticLayer(
    layer: HTMLCanvasElement | null,
    width: number,
    height: number,
  ): HTMLCanvasElement {
    const canvas = layer ?? document.createElement('canvas');
    const ratio = this.surface.pixelRatio;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, width, height);
    }
    return canvas;
  }

  private renderGridLayer(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    for (let az = 0; az < 360; az += 30) {
      ctx.beginPath();
      const x = az * this.AZIMUTH_TO_NORMALIZED * width;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderHorizonLayer(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    const base = this.mapAltitude(0);
    const gradientDepth = Math.min(80, this.cachedLogicalHeight * 0.15);

    ctx.beginPath();
    this.traceHorizonCurve(ctx, width);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = '#070707';
    ctx.fill();

    const glow = ctx.createLinearGradient(0, base - 30, 0, base + gradientDepth);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    glow.addColorStop(0.5, 'rgba(255, 255, 255, 0.18)');
    glow.addColorStop(1, 'rgba(5, 5, 5, 0)');
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

  private blitStaticLayer(layer: HTMLCanvasElement | null, type: 'grid' | 'horizon') {
    if (!layer) {
      this.ensureStaticLayers();
      layer = type === 'grid' ? this.gridLayer : this.horizonLayer;
      if (!layer) {
        return;
      }
    }
    const ctx = this.surface.context;
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, this.cachedLogicalWidth, this.cachedLogicalHeight);
  }

  private acquireHistoryCanvas(): HTMLCanvasElement {
    const canvas = this.historyCanvasPool.pop() ?? document.createElement('canvas');
    const targetWidth = this.activeTrail.canvas.width;
    const targetHeight = this.activeTrail.canvas.height;

    // Only resize if dimensions don't match (avoid unnecessary canvas operations)
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.style.width = this.activeTrail.canvas.style.width;
      canvas.style.height = this.activeTrail.canvas.style.height;
    }

    return canvas;
  }

  private releaseHistoryCanvas(canvas: HTMLCanvasElement) {
    this.historyCanvasPool.push(canvas);
  }

  private isSampleVisible(sample: HorizonSample) {
    const cutoff = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
    return sample.altitude >= cutoff;
  }

  private isSampleDrawable(sample: HorizonSample) {
    // Allow drawing slightly below horizon - the horizon band will occlude it
    const cutoff = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
    const tolerance = 5; // degrees below horizon we'll still draw
    return sample.altitude >= cutoff - tolerance;
  }

  private getCurvedHorizonAltitudeAtAzimuth(azimuth: number) {
    const x = this.mapAzimuth(azimuth);
    const y = this.getCurvedHorizonY(x);
    return this.unmapAltitude(y);
  }
}

/** Trail layer helpers */
type TrailLayer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
type HistoryLayer = { canvas: HTMLCanvasElement; age: number }; // age is now continuous (float)

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
