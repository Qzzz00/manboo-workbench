export type ResponseSyncPart = 'text' | 'audio' | 'motion';

type ResponseSyncPayload<TText, TAudio, TMotion> = {
  text: TText;
  audio: TAudio;
  motion: TMotion;
};

export type ResponseSyncResult<TText, TAudio, TMotion> = Partial<ResponseSyncPayload<TText, TAudio, TMotion>> & {
  id: string;
  degraded: boolean;
  missingParts: ResponseSyncPart[];
  firedAt: number;
};

type ResponseSyncRoundOptions<TText, TAudio, TMotion> = {
  id: string;
  timeoutMs?: number;
  onReady: (result: ResponseSyncResult<TText, TAudio, TMotion>) => void;
};

const RESPONSE_SYNC_PARTS: ResponseSyncPart[] = ['text', 'audio', 'motion'];
const DEFAULT_TIMEOUT_MS = 5000;

export class ResponseSyncRound<TText, TAudio, TMotion> {
  private readonly id: string;
  private readonly onReady: (result: ResponseSyncResult<TText, TAudio, TMotion>) => void;
  private readonly readyParts = new Set<ResponseSyncPart>();
  private readonly payload: Partial<ResponseSyncPayload<TText, TAudio, TMotion>> = {};
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private completed = false;

  constructor(options: ResponseSyncRoundOptions<TText, TAudio, TMotion>) {
    this.id = options.id;
    this.onReady = options.onReady;
    this.timeoutId = setTimeout(() => {
      this.flush(true);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  get isActive() {
    return !this.cancelled && !this.completed;
  }

  markTextReady(payload: TText) {
    this.markReady('text', payload);
  }

  markAudioReady(payload: TAudio) {
    this.markReady('audio', payload);
  }

  markMotionReady(payload: TMotion) {
    this.markReady('motion', payload);
  }

  cancel() {
    if (this.completed || this.cancelled) return;
    this.cancelled = true;
    this.clearTimer();
  }

  private markReady(part: ResponseSyncPart, payload: TText | TAudio | TMotion) {
    if (!this.isActive) return;

    this.readyParts.add(part);
    if (part === 'text') {
      this.payload.text = payload as TText;
    } else if (part === 'audio') {
      this.payload.audio = payload as TAudio;
    } else {
      this.payload.motion = payload as TMotion;
    }

    if (this.readyParts.size === RESPONSE_SYNC_PARTS.length) {
      this.flush(false);
    }
  }

  private flush(degraded: boolean) {
    if (!this.isActive) return;

    this.completed = true;
    this.clearTimer();

    const missingParts = RESPONSE_SYNC_PARTS.filter((part) => !this.readyParts.has(part));
    this.onReady({
      id: this.id,
      ...this.payload,
      degraded: degraded || missingParts.length > 0,
      missingParts,
      firedAt: performance.now(),
    });
  }

  private clearTimer() {
    if (!this.timeoutId) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }
}

export class ResponseSyncController<TText, TAudio, TMotion> {
  start(options: ResponseSyncRoundOptions<TText, TAudio, TMotion>) {
    return new ResponseSyncRound<TText, TAudio, TMotion>(options);
  }
}
