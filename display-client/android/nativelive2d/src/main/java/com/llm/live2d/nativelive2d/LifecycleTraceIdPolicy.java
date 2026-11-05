package com.llm.live2d.nativelive2d;

/** Keeps caller-owned handheld IDs intact and isolates ordinary-host fallback IDs below zero. */
final class LifecycleTraceIdPolicy {
    private LifecycleTraceIdPolicy() {}

    static long resolve(Long requestedId, long localSequence) {
        if (requestedId != null) return requestedId;
        return -Math.max(1L, localSequence);
    }
}
