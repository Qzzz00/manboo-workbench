export type GreetingPresentation = {
  avatarId: string;
  presentationId: number;
  visible: boolean;
  compositeReady: boolean;
};

export type GreetingClip = {
  audioBase64: string;
  mime: string;
};

export type GreetingPlaybackDeps = {
  warm: () => Promise<void>;
  getClip: () => GreetingClip | null;
  play: (clip: GreetingClip) => void | Promise<void>;
};

export type GreetingPlaybackGate = {
  update: (key: string | null, deps: GreetingPlaybackDeps) => () => void;
};

export type GreetingAudioTraceHost = {
  AibooHandheldStrip?: { audioStarted?: (presentationId: number) => void };
};

export type PetPresentationState = Pick<GreetingPresentation, 'presentationId' | 'visible'> & {
  revealedElapsedMs: number;
  receivedAt: number;
};

export type PetPresentationHost = {
  __petPresentation?: (visible: boolean, presentationId: number, revealedElapsedMs: number) => void;
};

declare global {
  interface Window {
    __petPresentation?: (visible: boolean, presentationId: number, revealedElapsedMs: number) => void;
  }
}

/** Hidden is the only safe default for a prewarmed strip whose early native notification was lost. */
export function initialGreetingPresentation(
  isHandheldStrip: boolean,
  receivedAt = performance.now(),
): PetPresentationState {
  return isHandheldStrip
    ? { visible: false, presentationId: 0, revealedElapsedMs: 0, receivedAt }
    : { visible: true, presentationId: 1, revealedElapsedMs: 0, receivedAt };
}

/** Install the native presentation callback without leaking over an existing/HMR callback. */
export function installPetPresentationBridge(
  host: PetPresentationHost,
  onPresentation: (visible: boolean, presentationId: number, revealedElapsedMs: number) => void,
): () => void {
  const previous = host.__petPresentation;
  const handler = (visible: boolean, presentationId: number, revealedElapsedMs: number) => {
    onPresentation(visible, presentationId, Math.max(0, revealedElapsedMs || 0));
  };
  host.__petPresentation = handler;

  return () => {
    if (host.__petPresentation !== handler) return;
    if (previous) host.__petPresentation = previous;
    else delete host.__petPresentation;
  };
}

/** A greeting exists only for one visible, fully composed native presentation. */
export function greetingPresentationKey(state: GreetingPresentation): string | null {
  if (!state.avatarId || !state.visible || !state.compositeReady) return null;
  if (!Number.isSafeInteger(state.presentationId) || state.presentationId <= 0) return null;
  return `${state.avatarId}:${state.presentationId}`;
}

/** Notify the native service at the real play boundary without crossing clip/content data. */
export function playGreetingClipAtBoundary(
  host: GreetingAudioTraceHost,
  presentationId: number,
  clip: GreetingClip,
  play: (audioBase64: string, mime: string) => void | Promise<void>,
): void | Promise<void> {
  if (Number.isSafeInteger(presentationId) && presentationId > 0) {
    try {
      host.AibooHandheldStrip?.audioStarted?.(presentationId);
    } catch {
      // Trace delivery is best-effort and must never suppress greeting playback.
    }
  }
  return play(clip.audioBase64, clip.mime);
}

/**
 * Owns async greeting cancellation independently from React and the native audio stop bridge.
 * Every update invalidates the older cache promise; a key is consumed immediately before play.
 */
export function createGreetingPlaybackGate(): GreetingPlaybackGate {
  let requestVersion = 0;
  let lastPlayedKey: string | null = null;

  return {
    update(key, deps) {
      const version = ++requestVersion;
      if (!key || lastPlayedKey === key) return () => {};

      void deps
        .warm()
        .then(() => {
          if (version !== requestVersion || lastPlayedKey === key) return;
          const clip = deps.getClip();
          if (!clip) return;
          lastPlayedKey = key;
          return deps.play(clip);
        })
        .catch(() => {
          // Cache warming and playback are best-effort. Never leak clip failures globally.
        });

      return () => {
        if (version === requestVersion) requestVersion += 1;
      };
    },
  };
}
