export type HandheldLifecyclePrefix =
  | '[handheld-home]'
  | '[handheld-strip]'
  | '[native-live2d]';

export type HandheldLifecyclePhase =
  | 'request'
  | 'host_resumed'
  | 'background_ready'
  | 'model_first_frame'
  | 'composite_ready'
  | 'revealed'
  | 'audio_started'
  | 'parked'
  | 'destroyed';

export type HandheldLifecycleTrace = {
  readonly prefix: HandheldLifecyclePrefix;
  readonly id: number;
  readonly startedAt: number;
  readonly recorded: Set<HandheldLifecyclePhase>;
};

type TraceSink = (message: string) => void;

export function createLifecycleTrace(
  prefix: HandheldLifecyclePrefix,
  id: number,
  startedAt = performance.now(),
): HandheldLifecycleTrace {
  return { prefix, id, startedAt, recorded: new Set() };
}

export function formatLifecyclePhase(
  trace: Pick<HandheldLifecycleTrace, 'prefix' | 'id' | 'startedAt'>,
  phase: HandheldLifecyclePhase,
  now: number,
): string {
  const elapsedMs = Math.max(0, Math.round(now - trace.startedAt));
  return `${trace.prefix} id=${trace.id} phase=${phase} elapsed=${elapsedMs}ms`;
}

/** Best-effort instrumentation: never changes the lifecycle path or throws into it. */
export function recordLifecyclePhase(
  trace: HandheldLifecycleTrace | null,
  phase: HandheldLifecyclePhase,
  now = performance.now(),
  sink: TraceSink = console.info,
): boolean {
  if (!trace || trace.recorded.has(phase)) return false;
  trace.recorded.add(phase);
  try {
    sink(formatLifecyclePhase(trace, phase, now));
  } catch {
    // Instrumentation must never own control flow.
  }
  return true;
}
