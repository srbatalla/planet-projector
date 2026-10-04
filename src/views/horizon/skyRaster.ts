import { createLayerCanvas } from '../../render/canvas';
import type { SkyProjection } from './projection';

/**
 * A low-resolution per-pixel sky buffer for full-sky effects (clouds, the Milky Way): every
 * pixel knows its sky direction (computed once per resize), effects fill `image`, and `commit`
 * upscales it once into a full-resolution cache so each frame only pays for a 1:1 copy.
 */
export class SkyRaster {
  lowWidth = 0;
  lowHeight = 0;
  scaleX = 1;
  scaleY = 1;
  /** Degrees; only meaningful where `valid` is 1 (pixels outside the dome are not sky). */
  azimuth = new Float32Array(0);
  altitude = new Float32Array(0);
  valid = new Uint8Array(0);
  image: ImageData | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private display: HTMLCanvasElement | null = null;
  private displayCtx: CanvasRenderingContext2D | null = null;

  constructor(private readonly targetPixels: number) {}

  get size() {
    return this.lowWidth * this.lowHeight;
  }

  resize(projection: SkyProjection, width: number, height: number, pixelRatio: number) {
    const scale = Math.max(1, Math.sqrt((width * height) / this.targetPixels));
    this.lowWidth = Math.max(8, Math.round(width / scale));
    this.lowHeight = Math.max(8, Math.round(height / scale));
    this.scaleX = width / this.lowWidth;
    this.scaleY = height / this.lowHeight;
    const n = this.size;
    this.azimuth = new Float32Array(n);
    this.altitude = new Float32Array(n);
    this.valid = new Uint8Array(n);
    for (let py = 0; py < this.lowHeight; py += 1) {
      for (let px = 0; px < this.lowWidth; px += 1) {
        const i = py * this.lowWidth + px;
        // Pixels a little below the horizon stay valid: the ground layer masks them cleanly.
        const sky = projection.unproject((px + 0.5) * this.scaleX, (py + 0.5) * this.scaleY);
        if (sky) {
          this.valid[i] = 1;
          this.azimuth[i] = sky.azimuth;
          this.altitude[i] = sky.altitude;
        }
      }
    }
    this.canvas = createLayerCanvas(this.lowWidth, this.lowHeight);
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx ? this.ctx.createImageData(this.lowWidth, this.lowHeight) : null;
    this.display = createLayerCanvas(Math.round(width * pixelRatio), Math.round(height * pixelRatio));
    this.displayCtx = this.display.getContext('2d');
  }

  /** Buffer index under a logical canvas point. */
  indexAt(x: number, y: number) {
    const px = Math.min(this.lowWidth - 1, Math.max(0, Math.floor(x / this.scaleX)));
    const py = Math.min(this.lowHeight - 1, Math.max(0, Math.floor(y / this.scaleY)));
    return py * this.lowWidth + px;
  }

  /** Publish `image`: upload it and refresh the smoothed full-resolution cache. */
  commit() {
    if (!this.image || !this.ctx || !this.canvas || !this.display || !this.displayCtx) {
      return;
    }
    this.ctx.putImageData(this.image, 0, 0);
    const dctx = this.displayCtx;
    dctx.clearRect(0, 0, this.display.width, this.display.height);
    dctx.imageSmoothingEnabled = true;
    // Bilinear ('low') is as soft as 'high' for a pure upscale and far cheaper to raster.
    dctx.imageSmoothingQuality = 'low';
    dctx.drawImage(this.canvas, 0, 0, this.display.width, this.display.height);
  }

  /** The cache already matches the canvas's backing size: a cheap 1:1 copy. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (this.display) {
      ctx.drawImage(this.display, 0, 0, width, height);
    }
  }

  /** Draw into another render (snapshots) through the projections' affine relation. */
  drawSnapshot(
    ctx: CanvasRenderingContext2D,
    target: SkyProjection,
    source: SkyProjection,
    sourceWidth: number,
    sourceHeight: number
  ) {
    const map = source.affineTo(target);
    if (!this.canvas || !map) {
      return;
    }
    ctx.save();
    ctx.transform(map.a, map.b, map.c, map.d, map.e, map.f);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(this.canvas, 0, 0, sourceWidth, sourceHeight);
    ctx.restore();
  }
}
