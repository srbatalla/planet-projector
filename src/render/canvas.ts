/**
 * Backing-store resolution is capped: 3× phone screens otherwise cost 2.25× the fill of 2×
 * for thin trails that look identical.
 */
export const MAX_PIXEL_RATIO = 2;

export function renderPixelRatio() {
  return Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
}

export function createLayerCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

export class CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ratio = 1;
  private logicalWidth = 0;
  private logicalHeight = 0;

  constructor(canvas: HTMLCanvasElement, opaque = true) {
    this.canvas = canvas;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const context = canvas.getContext('2d', { alpha: !opaque });
    if (!context) {
      throw new Error('Unable to acquire 2D rendering context.');
    }

    this.ctx = context;
    this.resize();
  }

  /** Match the backing store to the element's CSS size. Returns true when it changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const logicalWidth = Math.max(1, Math.round(rect.width) || 800);
    const logicalHeight = Math.max(1, Math.round(rect.height) || 600);
    const ratio = renderPixelRatio();
    const scaledWidth = Math.round(logicalWidth * ratio);
    const scaledHeight = Math.round(logicalHeight * ratio);

    if (this.canvas.width === scaledWidth && this.canvas.height === scaledHeight && ratio === this.ratio) {
      return false;
    }

    this.ratio = ratio;
    this.logicalWidth = logicalWidth;
    this.logicalHeight = logicalHeight;
    this.canvas.width = scaledWidth;
    this.canvas.height = scaledHeight;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return true;
  }

  clear(color = '#050505') {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  get width(): number {
    return this.logicalWidth;
  }

  get height(): number {
    return this.logicalHeight;
  }
}

/** Debounced ResizeObserver: the canvas CSS-stretches during the gap, then re-rasterizes once. */
export function observeResize(element: HTMLElement, onResize: () => void, delayMs = 120) {
  let handle: number | null = null;
  const observer = new ResizeObserver(() => {
    if (handle !== null) {
      window.clearTimeout(handle);
    }
    handle = window.setTimeout(() => {
      handle = null;
      onResize();
    }, delayMs);
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
    if (handle !== null) {
      window.clearTimeout(handle);
    }
  };
}
