import { Body, Observer } from 'astronomy-engine';
import { computeHorizonPoint, type HorizonSample } from '../../core/astro';
import { getPlanetColor } from './planetColors';

/** Trail layer helpers */
type TrailLayer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
type HistoryLayer = { canvas: HTMLCanvasElement; age: number; displayAge: number };

const createTrailLayer = (): TrailLayer => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }
  return { canvas, ctx };
};

const clearTrailLayer = (layer: TrailLayer) => {
  layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
};

type SamplePoint = {
  azimuth: number;
  altitude: number;
};

type PlanetRendererConfig = {
  body: Body;
  observer: Observer;
  baseTimestamp: number;
  stepMs: number;
  trailPersistence: number;
  azimuthCheckpointInterval: number;
  activeFadeRate: number;
  cycleLimit: number;
};

type CoordinateMappingFunctions = {
  mapAzimuth: (azimuth: number) => number;
  mapAltitude: (altitude: number) => number;
  getCurvedHorizonAltitudeAtAzimuth: (azimuth: number) => number;
  isSampleVisible: (sample: HorizonSample) => boolean;
  isSampleDrawable: (sample: HorizonSample) => boolean;
  toCanvasPoint: (sample: SamplePoint) => { x: number; y: number };
};

type CanvasPoolManager = {
  acquire: () => HTMLCanvasElement;
  release: (canvas: HTMLCanvasElement) => void;
};

/**
 * Manages trail rendering and aging for a single planet.
 * Each planet has its own active trail, history layers, and aging state.
 */
export class PlanetRenderer {
  private readonly activeTrail = createTrailLayer();
  private historyLayers: HistoryLayer[] = [];
  private lastVisibleSample: HorizonSample | null = null;
  private lastVisibleTimeMs = 0;
  private activeHasPaint = false;
  private lastAzimuthCheckpoint = 0;
  private cycleStartAzimuth = 0;
  private azimuthAgeThisCycle = 0;
  private pendingCycleAge = 0;
  private pendingCycleAgeApplied = 0;
  private completedCycles = 0;
  private pruneFrameCounter = 0;
  private readonly PRUNE_INTERVAL = 10;
  private readonly reusableDate = new Date();
  private readonly DISPLAY_AGE_CATCHUP_RATE = 1 / 400;
  private pixelRatio = 1;

  readonly color: string;

  constructor(
    private config: PlanetRendererConfig,
    private mappers: CoordinateMappingFunctions,
    private canvasPool: CanvasPoolManager
  ) {
    this.color = getPlanetColor(config.body);
  }

  get body(): Body {
    return this.config.body;
  }

  syncTrailCanvas(targetCanvas: HTMLCanvasElement, pixelRatio: number) {
    this.pixelRatio = Math.max(1, pixelRatio || 1);
    if (
      this.activeTrail.canvas.width !== targetCanvas.width ||
      this.activeTrail.canvas.height !== targetCanvas.height
    ) {
      this.activeTrail.canvas.width = targetCanvas.width;
      this.activeTrail.canvas.height = targetCanvas.height;
      this.activeTrail.canvas.style.width = targetCanvas.style.width;
      this.activeTrail.canvas.style.height = targetCanvas.style.height;
      this.activeTrail.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  private toPhysical(value: number) {
    return value * this.pixelRatio;
  }

  private toPhysicalPoint(point: { x: number; y: number }) {
    return {
      x: this.toPhysical(point.x),
      y: this.toPhysical(point.y),
    };
  }

  getLastVisibleSample(): HorizonSample | null {
    return this.lastVisibleSample;
  }

  setLastVisibleSample(sample: HorizonSample | null, timeMs: number = 0) {
    this.lastVisibleSample = sample;
    this.lastVisibleTimeMs = timeMs;
    if (sample) {
      this.lastAzimuthCheckpoint = sample.azimuth;
      this.cycleStartAzimuth = sample.azimuth;
    }
  }

  hasActivePaint(): boolean {
    return this.activeHasPaint;
  }

  clearActivePaint() {
    this.activeHasPaint = false;
  }

  clearActiveTrail() {
    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;
  }

  computeSampleAt(simTimeMs: number): HorizonSample {
    this.reusableDate.setTime(this.config.baseTimestamp + simTimeMs);
    return computeHorizonPoint({
      body: this.config.body,
      observer: this.config.observer,
      time: this.reusableDate,
    });
  }

  paintSegment(a: HorizonSample, b: HorizonSample) {
    const azDelta = Math.abs(b.azimuth - a.azimuth);
    if (azDelta > 180) {
      return; // Avoid wrapping artifacts
    }

    // Validate segment span to prevent "spawning mid-sky" effect
    const altitudeDelta = Math.abs(b.altitude - a.altitude);
    const aVisible = this.mappers.isSampleVisible(a);
    const bVisible = this.mappers.isSampleVisible(b);

    // If segment spans from below-horizon to far-above-horizon, subdivide it
    if (!aVisible && bVisible && altitudeDelta > 8) {
      const subdivisions = Math.ceil(altitudeDelta / 4);
      for (let i = 0; i < subdivisions; i++) {
        const t1 = i / subdivisions;
        const t2 = (i + 1) / subdivisions;

        const intermediate1: HorizonSample = {
          altitude: a.altitude + (b.altitude - a.altitude) * t1,
          azimuth: a.azimuth + (b.azimuth - a.azimuth) * t1,
          time: new Date(a.time.getTime() + (b.time.getTime() - a.time.getTime()) * t1)
        };

        const intermediate2: HorizonSample = {
          altitude: a.altitude + (b.altitude - a.altitude) * t2,
          azimuth: a.azimuth + (b.azimuth - a.azimuth) * t2,
          time: new Date(a.time.getTime() + (b.time.getTime() - a.time.getTime()) * t2)
        };

        this.paintSingleSegment(intermediate1, intermediate2);
      }
      return;
    }

    this.paintSingleSegment(a, b);
  }

  private paintSingleSegment(a: HorizonSample, b: HorizonSample) {
    const start = this.toPhysicalPoint(this.mappers.toCanvasPoint(a));
    const end = this.toPhysicalPoint(this.mappers.toCanvasPoint(b));

    this.activeTrail.ctx.save();
    this.activeTrail.ctx.lineWidth = 2 * this.pixelRatio;
    this.activeTrail.ctx.lineJoin = 'round';
    this.activeTrail.ctx.lineCap = 'round';
    this.activeTrail.ctx.strokeStyle = this.color;
    this.activeTrail.ctx.beginPath();
    this.activeTrail.ctx.moveTo(start.x, start.y);
    this.activeTrail.ctx.lineTo(end.x, end.y);
    this.activeTrail.ctx.stroke();
    this.activeTrail.ctx.restore();

    this.activeHasPaint = true;
  }

  fadeTrailLayer(deltaSimMs: number) {
    if (deltaSimMs <= 0 || this.config.activeFadeRate <= 0) {
      return;
    }

    const simSeconds = deltaSimMs / 1000;
    const alpha = 1 - Math.exp(-this.config.activeFadeRate * simSeconds);

    if (alpha <= 0) {
      return;
    }

    const canvas = this.activeTrail.canvas;
    this.activeTrail.ctx.save();
    this.activeTrail.ctx.globalCompositeOperation = 'destination-out';
    this.activeTrail.ctx.globalAlpha = Math.min(1, alpha);
    this.activeTrail.ctx.fillStyle = '#000000';
    this.activeTrail.ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.activeTrail.ctx.restore();
  }

  ageHistoryLayersByAzimuth(currentSample: HorizonSample | null) {
    if (!this.activeHasPaint || !currentSample) {
      return;
    }

    const currentAz = currentSample.azimuth;
    let azDelta = currentAz - this.lastAzimuthCheckpoint;

    // Handle azimuth wrapping
    if (azDelta < -180) {
      azDelta += 360;
    } else if (azDelta > 180) {
      azDelta -= 360;
    }

    const checkpointInterval = Math.max(1, this.config.azimuthCheckpointInterval);

    if (Math.abs(azDelta) >= checkpointInterval) {
      const ageIncrement = Math.abs(azDelta) / 360;
      this.azimuthAgeThisCycle += ageIncrement;

      for (let i = 0; i < this.historyLayers.length; i++) {
        this.historyLayers[i].age += ageIncrement;
      }

      this.lastAzimuthCheckpoint = currentAz;
    }
  }

  commitActiveTrailToHistory(): boolean {
    if (!this.activeHasPaint) {
      return false;
    }

    const completionBonus = Math.max(0, 1 - this.azimuthAgeThisCycle);
    this.pruneHistoryLayers();

    const snapshot = this.canvasPool.acquire();
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
        snapshot.height
      );
    }

    const newLayer: HistoryLayer = {
      canvas: snapshot,
      age: completionBonus,
      displayAge: completionBonus
    };

    this.historyLayers.push(newLayer);
    this.pendingCycleAge += 1;
    this.completedCycles++;

    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;
    this.azimuthAgeThisCycle = 0;

    return true;
  }

  incrementHistoryLayerCycles(deltaMs: number) {
    if (this.pendingCycleAge <= 0) {
      return;
    }

    const catchupIncrement = deltaMs * this.DISPLAY_AGE_CATCHUP_RATE;
    const applied = Math.min(catchupIncrement, this.pendingCycleAge - this.pendingCycleAgeApplied);
    this.pendingCycleAgeApplied += applied;

    for (let i = 0; i < this.historyLayers.length; i++) {
      this.historyLayers[i].displayAge += applied;
    }

    if (this.pendingCycleAgeApplied >= this.pendingCycleAge) {
      this.pendingCycleAge = 0;
      this.pendingCycleAgeApplied = 0;
    }
  }

  private pruneHistoryLayers() {
    for (let i = this.historyLayers.length - 1; i >= 0; i--) {
      if (this.historyLayers[i].age >= this.config.trailPersistence) {
        this.canvasPool.release(this.historyLayers[i].canvas);
        this.historyLayers.splice(i, 1);
      }
    }
  }

  drawHistoryLayers(targetCtx: CanvasRenderingContext2D, width: number, height: number) {
    if (++this.pruneFrameCounter >= this.PRUNE_INTERVAL) {
      this.pruneHistoryLayers();
      this.pruneFrameCounter = 0;
    }

    for (let i = 0; i < this.historyLayers.length; i++) {
      const layer = this.historyLayers[i];
      const ageRatio = layer.displayAge / this.config.trailPersistence;
      const alpha = 1 - ageRatio * ageRatio;

      if (alpha > 0.01) {
        targetCtx.save();
        targetCtx.globalAlpha = alpha;
        targetCtx.drawImage(layer.canvas, 0, 0, layer.canvas.width, layer.canvas.height, 0, 0, width, height);
        targetCtx.restore();
      }
    }
  }

  drawActiveTrail(targetCtx: CanvasRenderingContext2D, width: number, height: number) {
    if (this.activeHasPaint) {
      targetCtx.drawImage(
        this.activeTrail.canvas,
        0,
        0,
        this.activeTrail.canvas.width,
        this.activeTrail.canvas.height,
        0,
        0,
        width,
        height
      );
    }
  }

  handleResize(newCanvas: HTMLCanvasElement, pixelRatio: number) {
    this.syncTrailCanvas(newCanvas, pixelRatio);

    for (let i = 0; i < this.historyLayers.length; i++) {
      const layer = this.historyLayers[i];
      const oldCanvas = layer.canvas;
      const newLayerCanvas = this.canvasPool.acquire();

      const ctx = newLayerCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, newLayerCanvas.width, newLayerCanvas.height);
        ctx.drawImage(oldCanvas, 0, 0);
      }

      this.canvasPool.release(oldCanvas);
      layer.canvas = newLayerCanvas;
    }
  }

  reset() {
    this.lastVisibleSample = null;
    this.lastVisibleTimeMs = 0;
    clearTrailLayer(this.activeTrail);
    this.activeHasPaint = false;

    for (let i = 0; i < this.historyLayers.length; i++) {
      this.canvasPool.release(this.historyLayers[i].canvas);
    }
    this.historyLayers = [];

    this.lastAzimuthCheckpoint = 0;
    this.cycleStartAzimuth = 0;
    this.azimuthAgeThisCycle = 0;
    this.pendingCycleAge = 0;
    this.pendingCycleAgeApplied = 0;
    this.completedCycles = 0;
  }

  shouldStopDueToCycleLimit(): boolean {
    return this.config.cycleLimit > 0 && this.completedCycles >= this.config.cycleLimit;
  }
}
