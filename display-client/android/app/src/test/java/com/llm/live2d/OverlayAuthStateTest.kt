package com.llm.live2d

import org.junit.Assert.assertEquals
import org.junit.Test

class OverlayAuthStateTest {
    @Test
    fun `warm window auth changes from old credentials to new credentials`() {
        val state = OverlayAuthState("old-strategist", "old-voice")

        state.update("new-strategist", "new-voice")

        assertEquals(
            OverlayAuthSnapshot("new-strategist", "new-voice"),
            state.current(),
        )
    }

    @Test
    fun `empty update clears both credentials instead of retaining warm values`() {
        val state = OverlayAuthState("old-strategist", "old-voice")

        state.update("", "")

        assertEquals(OverlayAuthSnapshot("", ""), state.current())
    }
}
