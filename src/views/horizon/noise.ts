/** Tileable value noise shared by the sky effects (clouds, Milky Way). */
export const NOISE_SIZE = 256;

/** Small seeded PRNG (mulberry32): the same run always gets the same clouds. */
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable fractal value noise in [0, 1]. */
export function makeNoise(seed: number): Float32Array {
  const rand = random(seed);
  const out = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  let total = 0;
  for (let octave = 0; octave < 5; octave += 1) {
    const grid = 4 << octave;
    const weight = 0.5 ** octave;
    total += weight;
    const lattice = new Float32Array(grid * grid);
    for (let i = 0; i < lattice.length; i += 1) {
      lattice[i] = rand();
    }
    for (let y = 0; y < NOISE_SIZE; y += 1) {
      const gy = (y / NOISE_SIZE) * grid;
      const y0 = Math.floor(gy);
      const ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const y1 = (y0 + 1) % grid;
      for (let x = 0; x < NOISE_SIZE; x += 1) {
        const gx = (x / NOISE_SIZE) * grid;
        const x0 = Math.floor(gx);
        const tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % grid;
        const a = lattice[y0 * grid + x0];
        const b = lattice[y0 * grid + x1];
        const c = lattice[y1 * grid + x0];
        const d = lattice[y1 * grid + x1];
        out[y * NOISE_SIZE + x] += weight * (a + (b - a) * sx + (c - a + (d - c - b + a) * sx) * sy);
      }
    }
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] /= total;
  }
  return out;
}

/**
 * Bilinear sample of the tileable texture (texel units). Nearest sampling leaves stepped
 * plateaus wherever a texel covers several screen pixels, which the upscale turns into blocks.
 */
export function sampleBilinear(noise: Float32Array, mask: number, u: number, v: number) {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const xa = x0 & mask;
  const xb = (x0 + 1) & mask;
  const ya = (y0 & mask) * NOISE_SIZE;
  const yb = ((y0 + 1) & mask) * NOISE_SIZE;
  const top = noise[ya + xa] + (noise[ya + xb] - noise[ya + xa]) * fx;
  const bottom = noise[yb + xa] + (noise[yb + xb] - noise[yb + xa]) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Wrap-around box blur (two passes ≈ Gaussian). Far-off deck points cover many texels per
 * pixel; sampling this pre-filtered copy there (like a mipmap) stops the detail aliasing.
 */
export function blurNoise(source: Float32Array, radius: number): Float32Array {
  let current = source;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const horizontal of [true, false]) {
      const out = new Float32Array(current.length);
      const span = radius * 2 + 1;
      for (let line = 0; line < NOISE_SIZE; line += 1) {
        const at = (k: number) => {
          const wrapped = ((k % NOISE_SIZE) + NOISE_SIZE) % NOISE_SIZE;
          return horizontal ? current[line * NOISE_SIZE + wrapped] : current[wrapped * NOISE_SIZE + line];
        };
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          sum += at(k);
        }
        for (let k = 0; k < NOISE_SIZE; k += 1) {
          out[horizontal ? line * NOISE_SIZE + k : k * NOISE_SIZE + line] = sum / span;
          sum += at(k + radius + 1) - at(k - radius);
        }
      }
      current = out;
    }
  }
  return current;
}
