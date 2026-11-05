package com.llm.live2d.nativelive2d;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class CompositeFrameGateTest {
    @Test
    public void waitsForRequestedBackgroundAndModelInSameOrLaterFrame() {
        CompositeFrameGate gate = new CompositeFrameGate();
        long background = gate.requestBackgroundChange();
        AtomicInteger called = new AtomicInteger();
        gate.awaitNextFrame(called::incrementAndGet);
        assertNull(gate.completeFrame(true));
        gate.markBackgroundDrawn(background);
        Runnable ready = gate.completeFrame(true);
        assertNotNull(ready);
        ready.run();
        assertEquals(1, called.get());
    }

    @Test
    public void invalidatedEglBackgroundMustBeRedrawnBeforeResumeCompletes() {
        CompositeFrameGate gate = new CompositeFrameGate();
        long background = gate.requestBackgroundChange();
        gate.markBackgroundDrawn(background);
        gate.invalidateBackground();
        gate.awaitNextFrame(() -> {});
        assertNull(gate.completeFrame(true));
        gate.markBackgroundDrawn(background);
        assertNotNull(gate.completeFrame(true));
    }

    @Test
    public void registrationDuringCurrentFrameWaitsForStrictlyLaterFrame() {
        CompositeFrameGate gate = new CompositeFrameGate();
        AtomicInteger called = new AtomicInteger();

        gate.awaitNextFrame(called::incrementAndGet);
        assertNull(gate.completeFrame(true));
        assertEquals(0, called.get());

        Runnable ready = gate.completeFrame(true);
        assertNotNull(ready);
        ready.run();
        assertEquals(1, called.get());
    }
}
