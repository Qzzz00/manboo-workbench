package com.llm.live2d.nativelive2d;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LifecycleTraceFormatterTest {
    @Test
    public void formatsOnlyPrefixIdPhaseAndMonotonicElapsedTime() {
        assertEquals(
            "[native-live2d] id=4 phase=composite_ready elapsed=18ms",
            LifecycleTraceFormatter.format("[native-live2d]", 4L, "composite_ready", 18L)
        );
    }

    @Test
    public void clampsNegativeElapsedTime() {
        assertEquals(
            "[handheld-strip] id=2 phase=request elapsed=0ms",
            LifecycleTraceFormatter.format("[handheld-strip]", 2L, "request", -3L)
        );
    }

    @Test
    public void requestRegisteredMidFrameCannotClaimThatFrame() {
        assertTrue(LifecycleTraceFramePolicy.ownsFrame(3L, 3L));
        assertFalse(LifecycleTraceFramePolicy.ownsFrame(3L, 4L));
    }

    @Test
    public void handheldTraceIdIsPreservedAcrossControllerAndRenderer() {
        assertEquals(41L, LifecycleTraceIdPolicy.resolve(41L, 7L));
    }

    @Test
    public void ordinaryHostFallbackUsesDistinctNegativeNamespace() {
        assertEquals(-7L, LifecycleTraceIdPolicy.resolve(null, 7L));
        assertEquals(0L, LifecycleTraceIdPolicy.resolve(0L, 7L));
    }

    @Test
    public void onlyRealNativeBoundariesOwnNativePhases() {
        assertFalse(LifecycleTracePhasePolicy.isBackgroundReady(false, 7, 720, 720));
        assertFalse(LifecycleTracePhasePolicy.isBackgroundReady(true, 0, 720, 720));
        assertFalse(LifecycleTracePhasePolicy.isBackgroundReady(true, 7, 0, 720));
        assertFalse(LifecycleTracePhasePolicy.isBackgroundReady(true, 7, 720, 0));
        assertTrue(LifecycleTracePhasePolicy.isBackgroundReady(true, 7, 720, 720));
        assertFalse(LifecycleTracePhasePolicy.isHostResumed(false));
        assertTrue(LifecycleTracePhasePolicy.isHostResumed(true));
    }
}
