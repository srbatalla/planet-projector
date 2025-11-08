export class CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ratio = window.devicePixelRatio || 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to acquire 2D rendering context.');
    }

    this.ctx = context;
    this.resize();
  }

  resize(width?: number, height?: number) {
    const logicalWidth = width ?? this.canvas.clientWidth;
    const logicalHeight = height ?? this.canvas.clientHeight;
    const targetWidth = Math.floor(logicalWidth > 0 ? logicalWidth : 800);
    const targetHeight = Math.floor(logicalHeight > 0 ? logicalHeight : 600);
    this.ratio = window.devicePixelRatio || 1;
    const scaledWidth = targetWidth * this.ratio;
    const scaledHeight = targetHeight * this.ratio;

    if (this.canvas.width !== scaledWidth || this.canvas.height !== scaledHeight) {
      this.canvas.width = scaledWidth;
      this.canvas.height = scaledHeight;
      this.canvas.style.width = `${targetWidth}px`;
      this.canvas.style.height = `${targetHeight}px`;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(this.ratio, this.ratio);
    }
  }

  clear(color = '#050505') {
    this.ctx.save();
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.canvas.width / this.ratio, this.canvas.height / this.ratio);
    this.ctx.restore();
  }

  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  get pixelRatio(): number {
    return this.ratio;
  }
}
