package com.llm.live2d.nativelive2d;

/** A frame may report phases only for the request that was current when that frame began. */
final class LifecycleTraceFramePolicy {
    private LifecycleTraceFramePolicy() {}

    static boolean ownsFrame(long frameStartRequestId, long currentRequestId) {
        return frameStartRequestId == currentRequestId;
    }
}
