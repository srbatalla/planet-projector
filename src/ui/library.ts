/**
 * Saved runs, kept on this device (localStorage). Each entry stores the compact share code of
 * its settings plus a small JPEG thumbnail. Storage can be unavailable (private mode, blocked
 * site data) or full, so every access is guarded and the UI degrades to an explanatory message.
 */
export type LibraryEntry = {
  id: string;
  name: string;
  /** Compact settings code (see shareCodec), without the `z=` prefix. */
  code: string;
  thumbnail: string;
  savedAt: number;
};

const STORAGE_KEY = 'planetary-patterns:library:v1';
const MAX_ENTRIES = 80;

export function loadLibrary(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is LibraryEntry =>
        !!entry &&
        typeof entry.id === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.code === 'string' &&
        typeof entry.thumbnail === 'string' &&
        typeof entry.savedAt === 'number'
    );
  } catch {
    return [];
  }
}

/** Returns false when the entries could not be written (storage blocked or full). */
export function storeLibrary(entries: LibraryEntry[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    return true;
  } catch {
    return false;
  }
}

export function libraryAvailable(): boolean {
  try {
    const probe = `${STORAGE_KEY}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Small JPEG of the canvas for the library list (~5–10 kB). */
export function makeThumbnail(source: HTMLCanvasElement, width = 192): string {
  try {
    const aspect = source.height / Math.max(1, source.width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(width * Math.min(1.6, Math.max(0.4, aspect))));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return '';
    }
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Centre-crop so very tall/wide canvases still give a readable tile.
    const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return '';
  }
}

export function newEntryId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
