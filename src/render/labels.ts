export const MARKER_LABEL_FONT = '11px "JetBrains Mono", "Fira Code", ui-monospace, monospace';
const LABEL_HEIGHT = 11;

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Keeps one frame's name tags from overprinting each other or other bodies' markers: each tag
 * takes the first free corner around its marker, starting from the usual one.
 */
export class LabelLayout {
  private placed: Box[] = [];
  private markers: { x: number; y: number; r: number }[] = [];

  reset() {
    this.placed.length = 0;
    this.markers.length = 0;
  }

  /** Register every marker before placing labels so a tag never covers a neighbour's dot. */
  addMarker(x: number, y: number, radius: number) {
    this.markers.push({ x, y, r: radius });
  }

  /** True when `box` is free of placed tags and of every marker except the label's own. */
  fits(box: Box, ownX: number, ownY: number) {
    for (const other of this.placed) {
      if (box.x0 < other.x1 + 2 && box.x1 > other.x0 - 2 && box.y0 < other.y1 + 1 && box.y1 > other.y0 - 1) {
        return false;
      }
    }
    for (const marker of this.markers) {
      if (marker.x === ownX && marker.y === ownY) {
        continue;
      }
      if (box.x0 < marker.x + marker.r && box.x1 > marker.x - marker.r && box.y0 < marker.y + marker.r && box.y1 > marker.y - marker.r) {
        return false;
      }
    }
    return true;
  }

  place(box: Box) {
    this.placed.push(box);
  }
}

/**
 * Name tag beside a marker: right of it and above by default, flipped left near the right edge and
 * below near the top. With a `layout`, the first corner that collides with nothing is used.
 */
export function drawMarkerLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  color: string,
  x: number,
  y: number,
  width: number,
  gap = 9,
  layout?: LabelLayout
) {
  const preferLeft = x > width - 80;
  const preferBelow = y < 24;
  let left = preferLeft;
  let below = preferBelow;
  if (layout) {
    const textWidth = ctx.measureText(text).width;
    const corners: [boolean, boolean][] = [
      [preferLeft, preferBelow],
      [!preferLeft, preferBelow],
      [preferLeft, !preferBelow],
      [!preferLeft, !preferBelow],
    ];
    let chosen: Box | null = null;
    for (const [tryLeft, tryBelow] of corners) {
      const x0 = tryLeft ? x - gap - textWidth : x + gap;
      const y0 = tryBelow ? y + gap - 2 : y + 2 - gap - LABEL_HEIGHT;
      const box = { x0, y0, x1: x0 + textWidth, y1: y0 + LABEL_HEIGHT };
      if (box.x0 < 0 || box.x1 > width || box.y0 < 0) {
        continue;
      }
      if (layout.fits(box, x, y)) {
        left = tryLeft;
        below = tryBelow;
        chosen = box;
        break;
      }
    }
    if (chosen) {
      layout.place(chosen);
    }
  }
  ctx.textAlign = left ? 'right' : 'left';
  ctx.textBaseline = below ? 'top' : 'bottom';
  ctx.fillStyle = color;
  ctx.fillText(text, x + (left ? -gap : gap), y + (below ? gap - 2 : 2 - gap));
}
