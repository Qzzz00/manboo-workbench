package com.llm.live2d

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StrategistAudioSessionGateTest {
    private fun session(
        gate: StrategistAudioSessionGate,
        events: MutableList<String>,
        label: String,
    ) = gate.begin(
        release = { events += "$label:release" },
        abandonFocus = { events += "$label:abandon" },
        onDone = { events += "$label:done" },
    )

    @Test
    fun `natural completion releases and settles exactly once`() {
        val events = mutableListOf<String>()
        val gate = StrategistAudioSessionGate()
        val active = session(gate, events, "one")

        gate.finish(active)
        gate.finish(active)

        assertEquals(listOf("one:release", "one:abandon", "one:done"), events)
    }

    @Test
    fun `stop settles active playback exactly once`() {
        val events = mutableListOf<String>()
        val gate = StrategistAudioSessionGate()
        session(gate, events, "one")

        gate.stop()

        assertEquals(listOf("one:release", "one:abandon", "one:done"), events)
    }

    @Test
    fun `double stop cannot settle the same playback twice`() {
        val events = mutableListOf<String>()
        val gate = StrategistAudioSessionGate()
        session(gate, events, "one")

        gate.stop()
        gate.stop()

        assertEquals(1, events.count { it == "one:done" })
        assertEquals(1, events.count { it == "one:abandon" })
    }

    @Test
    fun `new playback stops old session while keeping new session active`() {
        val events = mutableListOf<String>()
        val gate = StrategistAudioSessionGate()
        val old = session(gate, events, "old")

        val current = session(gate, events, "new")

        assertEquals(listOf("old:release", "old:abandon", "old:done"), events)
        assertTrue(gate.isActive(current))
        gate.finish(old)
        gate.finish(current)
        assertEquals(1, events.count { it == "old:done" })
        assertEquals(1, events.count { it == "new:done" })
    }

    @Test
    fun `focus is abandoned after release and before interrupted done callback`() {
        val events = mutableListOf<String>()
        val gate = StrategistAudioSessionGate()
        session(gate, events, "one")

        gate.stop()

        assertEquals(listOf("one:release", "one:abandon", "one:done"), events)
    }

    @Test
    fun `replacement done callback can reenter without resurrecting the superseded session`() {
        val gate = StrategistAudioSessionGate()
        lateinit var reentrant: StrategistAudioSessionGate.Session
        gate.begin(
            release = {},
            abandonFocus = {},
            onDone = {
                reentrant = gate.begin(release = {}, abandonFocus = {}, onDone = {})
            },
        )

        val superseded = gate.begin(release = {}, abandonFocus = {}, onDone = {})

        assertFalse(gate.isActive(superseded))
        assertTrue(gate.isActive(reentrant))
    }
}
