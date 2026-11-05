package com.llm.live2d.nativelive2d;

/**
 * Gates a visibility handoff until one frame contains both the requested background revision and
 * a loaded model. All state is pure Java so lifecycle ordering can be unit-tested without Android.
 */
final class CompositeFrameGate {
    private long requestedBackgroundRevision;
    private long drawnBackgroundRevision;
    private long requiredBackgroundRevision;
    /** Frames fully completed before the current completeFrame call; incremented after evaluation. */
    private long completedFrameSequence;
    private long requiredCompletedFrameSequence;
    private Runnable pendingCallback;

    synchronized long requestBackgroundChange() {
        return ++requestedBackgroundRevision;
    }

    synchronized void markBackgroundDrawn(long revision) {
        drawnBackgroundRevision = Math.max(drawnBackgroundRevision, revision);
    }

    synchronized void invalidateBackground() {
        drawnBackgroundRevision = -1;
    }

    synchronized void awaitNextFrame(Runnable callback) {
        requiredBackgroundRevision = requestedBackgroundRevision;
        requiredCompletedFrameSequence = completedFrameSequence;
        pendingCallback = callback;
    }

    synchronized Runnable completeFrame(boolean modelDrawn) {
        Runnable ready = null;
        if (pendingCallback != null
            && completedFrameSequence > requiredCompletedFrameSequence
            && modelDrawn
            && drawnBackgroundRevision >= requiredBackgroundRevision) {
            ready = pendingCallback;
            pendingCallback = null;
        }
        completedFrameSequence++;
        return ready;
    }
}
