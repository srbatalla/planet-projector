/**
 * H.264 MP4 first: it plays everywhere, including iPhone Photos, and both Safari and Chrome 126+
 * can record it. WebM (Firefox, Chromium builds without H.264) does not play on iOS. A bare
 * 'video/mp4' comes last because Chromium may fill it with VP9, which iOS cannot decode either.
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.4d0028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export type RecorderState = { recording: boolean; remainingSeconds: number };

/** Records the live canvas to a short WebM (or MP4 on Safari) clip, entirely on device. */
export class ClipRecorder {
  private recorder: MediaRecorder | null = null;
  private tickHandle: number | null = null;
  private endsAt = 0;

  constructor(
    private readonly onState: (state: RecorderState) => void,
    private readonly onClip: (clip: Blob, extension: string, iosPlayable: boolean) => void
  ) {}

  static isSupported() {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
      MIME_CANDIDATES.some((mime) => MediaRecorder.isTypeSupported(mime))
    );
  }

  get recording() {
    return this.recorder !== null;
  }

  start(canvas: HTMLCanvasElement, seconds: number) {
    if (this.recorder) {
      return;
    }
    const mimeType = MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) {
      return;
    }
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 10_000_000 });
    // Per-recording buffer: a previous recorder's late onstop must not touch this one's chunks.
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const type = mimeType.split(';')[0];
      if (chunks.length > 0) {
        this.onClip(new Blob(chunks, { type }), type === 'video/mp4' ? 'mp4' : 'webm', mimeType.includes('avc1'));
      }
    };
    recorder.start(250);
    this.recorder = recorder;
    this.endsAt = performance.now() + seconds * 1000;
    this.tick();
    this.tickHandle = window.setInterval(() => this.tick(), 250);
  }

  stop() {
    if (!this.recorder) {
      return;
    }
    if (this.tickHandle !== null) {
      window.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    this.onState({ recording: false, remainingSeconds: 0 });
  }

  private tick() {
    const remaining = Math.max(0, Math.ceil((this.endsAt - performance.now()) / 1000));
    if (remaining <= 0) {
      this.stop();
      return;
    }
    this.onState({ recording: true, remainingSeconds: remaining });
  }
}
