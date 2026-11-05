package com.llm.live2d.nativelive2d;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class GlContextWorkQueueTest {
    @Test
    public void defersGpuWorkUntilContextIsReady() {
        GlContextWorkQueue queue = new GlContextWorkQueue();
        StringBuilder events = new StringBuilder();

        queue.enqueue(() -> events.append('a'));
        queue.enqueue(() -> events.append('b'));

        assertEquals("", events.toString());

        queue.markReady();

        assertEquals("ab", events.toString());
    }

    @Test
    public void executesNewGpuWorkImmediatelyAfterContextIsReady() {
        GlContextWorkQueue queue = new GlContextWorkQueue();
        StringBuilder events = new StringBuilder();

        queue.markReady();
        queue.enqueue(() -> events.append('a'));

        assertEquals("a", events.toString());
    }

    @Test
    public void waitsForTheReplacementContextAfterItIsLost() {
        GlContextWorkQueue queue = new GlContextWorkQueue();
        StringBuilder events = new StringBuilder();

        queue.markReady();
        queue.markNotReady();
        queue.enqueue(() -> events.append('a'));

        assertEquals("", events.toString());

        queue.markReady();

        assertEquals("a", events.toString());
    }
}
