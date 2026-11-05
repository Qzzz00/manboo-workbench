package com.llm.live2d.nativelive2d;

/** Lifecycle phases are eligible only after their native operation has actually completed. */
final class LifecycleTracePhasePolicy {
    private LifecycleTracePhasePolicy() {}

    static boolean isBackgroundReady(
        boolean drawBackgroundCompleted,
        int textureId,
        int surfaceWidth,
        int surfaceHeight
    ) {
        return drawBackgroundCompleted && textureId != 0 && surfaceWidth > 0 && surfaceHeight > 0;
    }

    static boolean isHostResumed(boolean nativeHostResumeCompleted) {
        return nativeHostResumeCompleted;
    }
}
