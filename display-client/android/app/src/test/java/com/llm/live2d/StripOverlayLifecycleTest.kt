package com.llm.live2d

import com.llm.live2d.StripOverlayLifecycle.Command.CREATE_HIDDEN
import com.llm.live2d.StripOverlayLifecycle.Command.DESTROY
import com.llm.live2d.StripOverlayLifecycle.Command.NONE
import com.llm.live2d.StripOverlayLifecycle.Command.PARK
import com.llm.live2d.StripOverlayLifecycle.Command.REBUILD_VISIBLE
import com.llm.live2d.StripOverlayLifecycle.Command.RESUME_HIDDEN
import com.llm.live2d.StripOverlayLifecycle.Command.REVEAL
import com.llm.live2d.StripOverlayLifecycle.Command.SHOW_LOADING
import com.llm.live2d.StripOverlayLifecycle.Phase.COLD
import com.llm.live2d.StripOverlayLifecycle.Phase.PRESENTING
import com.llm.live2d.StripOverlayLifecycle.Phase.READY_PARKED
import com.llm.live2d.StripOverlayLifecycle.Phase.VISIBLE
import com.llm.live2d.StripOverlayLifecycle.Phase.WARMING_HIDDEN
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StripOverlayLifecycleTest {
    @Test
    fun `Figma handheld strip uses persistent lifecycle`() {
        assertEquals(
            OverlayStartMode.PERSISTENT_STRIP,
            OverlayStartPolicy.modeFor("renderer=native&stripUi=figma-handheld&strip=1"),
        )
        assertEquals(
            OverlayStartMode.PERSISTENT_STRIP,
            OverlayStartPolicy.modeFor("stripUi=%66igma-handheld"),
        )
    }

    @Test
    fun `ordinary and lookalike overlays remain ephemeral`() {
        assertEquals(OverlayStartMode.EPHEMERAL, OverlayStartPolicy.modeFor("bg=1"))
        assertEquals(OverlayStartMode.EPHEMERAL, OverlayStartPolicy.modeFor("strip=1"))
        assertEquals(
            OverlayStartMode.EPHEMERAL,
            OverlayStartPolicy.modeFor("note=stripUi%3Dfigma-handheld"),
        )
        assertEquals(
            OverlayStartMode.EPHEMERAL,
            OverlayStartPolicy.modeFor("stripUi=figma-handheld-preview"),
        )
        assertEquals(OverlayStartMode.EPHEMERAL, OverlayStartPolicy.modeFor("stripUi=%ZZ"))
    }

    @Test
    fun `prewarm starts and persists without moving the main task`() {
        assertEquals(
            OverlayLaunchBehavior(persistStripParams = true, startService = true, moveTaskToBack = false),
            OverlayLaunchPolicy.forRequest(OverlayLaunchRequest.PREWARM, fixed = true),
        )
    }

    @Test
    fun `ordinary start and save retain their existing launch semantics`() {
        assertEquals(
            OverlayLaunchBehavior(persistStripParams = false, startService = true, moveTaskToBack = true),
            OverlayLaunchPolicy.forRequest(OverlayLaunchRequest.START, fixed = false),
        )
        assertEquals(
            OverlayLaunchBehavior(persistStripParams = false, startService = true, moveTaskToBack = false),
            OverlayLaunchPolicy.forRequest(OverlayLaunchRequest.START, fixed = true),
        )
        assertEquals(
            OverlayLaunchBehavior(persistStripParams = true, startService = false, moveTaskToBack = false),
            OverlayLaunchPolicy.forRequest(OverlayLaunchRequest.SAVE_ONLY, fixed = false),
        )
    }

    @Test
    fun `handheld strip start persists the same intent it launches`() {
        assertEquals(
            OverlayLaunchBehavior(persistStripParams = true, startService = true, moveTaskToBack = false),
            OverlayLaunchPolicy.forRequest(
                OverlayLaunchRequest.START,
                fixed = true,
                persistentStrip = true,
            ),
        )
    }

    @Test
    fun `F10 action order distinguishes visible warm and cold strip`() {
        assertEquals(
            StripKeyAction.PARK,
            StripKeyActionPolicy.choose(
                overlayRunning = true,
                overlayVisible = true,
                persistentStrip = true,
                aibooForeground = true,
                hasSavedIntent = true,
            ),
        )
        assertEquals(
            StripKeyAction.IGNORE,
            StripKeyActionPolicy.choose(true, false, true, true, true),
        )
        assertEquals(
            StripKeyAction.PRESENT_WARM,
            StripKeyActionPolicy.choose(true, false, true, false, true),
        )
        assertEquals(
            StripKeyAction.START_COLD,
            StripKeyActionPolicy.choose(false, false, false, false, true),
        )
        assertEquals(
            StripKeyAction.STOP_EPHEMERAL,
            StripKeyActionPolicy.choose(true, true, false, false, true),
        )
        assertEquals(
            StripKeyAction.STOP_EPHEMERAL,
            StripKeyActionPolicy.choose(true, false, false, false, true),
        )
        assertEquals(
            StripKeyAction.IGNORE,
            StripKeyActionPolicy.choose(false, false, false, false, false),
        )
    }

    @Test
    fun `prewarm becomes ready parked after hidden composite`() {
        val lifecycle = StripOverlayLifecycle()

        assertEquals(CREATE_HIDDEN, lifecycle.prewarm())
        assertEquals(PARK, lifecycle.onCompositeReady())
        assertEquals(READY_PARKED, lifecycle.state.phase)
        assertTrue(lifecycle.state.hasCompositeFrame)
    }

    @Test
    fun `F10 on parked resumes then reveals only after next frame`() {
        val lifecycle = readyParkedLifecycle()

        assertEquals(RESUME_HIDDEN, lifecycle.toggle())
        assertEquals(PRESENTING, lifecycle.state.phase)
        assertEquals(REVEAL, lifecycle.onCompositeReady())
        assertEquals(VISIBLE, lifecycle.state.phase)
    }

    @Test
    fun `F10 while visible parks without destroying resources`() {
        val lifecycle = visibleLifecycle()

        assertEquals(PARK, lifecycle.toggle())
        assertEquals(READY_PARKED, lifecycle.state.phase)
        assertTrue(lifecycle.state.hasCompositeFrame)
    }

    @Test
    fun `destroy always returns cold`() {
        val lifecycle = visibleLifecycle()

        assertEquals(DESTROY, lifecycle.destroy())
        assertEquals(COLD, lifecycle.state.phase)
        assertFalse(lifecycle.state.hasCompositeFrame)
    }

    @Test
    fun `F10 during warming shows loading then initial composite reveals`() {
        val lifecycle = StripOverlayLifecycle()
        assertEquals(CREATE_HIDDEN, lifecycle.prewarm())

        assertEquals(SHOW_LOADING, lifecycle.toggle())
        assertEquals(PRESENTING, lifecycle.state.phase)
        assertFalse(lifecycle.state.hasCompositeFrame)
        assertEquals(REVEAL, lifecycle.onCompositeReady())
        assertEquals(VISIBLE, lifecycle.state.phase)
    }

    @Test
    fun `F10 hides loading before initial composite and warming continues`() {
        val lifecycle = StripOverlayLifecycle()
        lifecycle.prewarm()
        lifecycle.toggle()

        assertEquals(PARK, lifecycle.toggle())
        assertEquals(WARMING_HIDDEN, lifecycle.state.phase)
        assertFalse(lifecycle.state.hasCompositeFrame)
        assertEquals(PARK, lifecycle.onCompositeReady())
        assertEquals(READY_PARKED, lifecycle.state.phase)
    }

    @Test
    fun `parking before first composite keeps hidden warming alive`() {
        assertEquals(
            StripParkExecution.KEEP_WARMING_HIDDEN,
            StripParkPolicy.forPhase(WARMING_HIDDEN),
        )
        assertEquals(
            StripParkExecution.PAUSE_PARKED,
            StripParkPolicy.forPhase(READY_PARKED),
        )
    }

    @Test
    fun `stale renderer frame cannot reveal a rebuilt or cancelled presentation`() {
        assertTrue(
            StripFrameOwnershipPolicy.accept(
                expectedPresentationId = 4,
                currentPresentationId = 4,
                sourceIsCurrentWindow = true,
                phase = PRESENTING,
            ),
        )
        assertFalse(StripFrameOwnershipPolicy.accept(4, 4, false, PRESENTING))
        assertFalse(StripFrameOwnershipPolicy.accept(4, 5, true, PRESENTING))
        assertFalse(StripFrameOwnershipPolicy.accept(4, 4, true, READY_PARKED))
    }

    @Test
    fun `frame wait uses native composite only while native controller is attached`() {
        assertEquals(
            StripFrameWaitSource.NATIVE_COMPOSITE,
            StripFrameWaitPolicy.forRenderer(nativeControllerAttached = true),
        )
        assertEquals(
            StripFrameWaitSource.WEBVIEW_VISUAL_STATE,
            StripFrameWaitPolicy.forRenderer(nativeControllerAttached = false),
        )
    }

    @Test
    fun `native and WebView frame completions reveal at most once and reject stale owners`() {
        StripFrameWaitSource.entries.forEach { source ->
            val current = StripFrameCompletionGate(expectedPresentationId = 4)
            assertTrue(
                "$source must accept its current presentation frame",
                current.accept(4, sourceIsCurrentWindow = true, PRESENTING),
            )
            assertFalse(
                "$source must not complete the same presentation twice",
                current.accept(4, sourceIsCurrentWindow = true, PRESENTING),
            )

            val stale = StripFrameCompletionGate(expectedPresentationId = 4)
            assertFalse(
                "$source must reject a replaced window",
                stale.accept(4, sourceIsCurrentWindow = false, PRESENTING),
            )
            assertFalse(
                "$source must reject a newer presentation",
                stale.accept(5, sourceIsCurrentWindow = true, PRESENTING),
            )
            assertTrue(
                "$source must not consume its one completion on stale callbacks",
                stale.accept(4, sourceIsCurrentWindow = true, PRESENTING),
            )
        }
    }

    @Test
    fun `ready callback belongs only to the window that is still current`() {
        assertEquals(
            OverlayReadyRoute.IGNORE,
            OverlayReadyOwnershipPolicy.route(
                sourceIsCurrentWindow = false,
                persistentStrip = false,
            ),
        )
        assertEquals(
            OverlayReadyRoute.EPHEMERAL,
            OverlayReadyOwnershipPolicy.route(
                sourceIsCurrentWindow = true,
                persistentStrip = false,
            ),
        )
        assertEquals(
            OverlayReadyRoute.PERSISTENT_STRIP,
            OverlayReadyOwnershipPolicy.route(
                sourceIsCurrentWindow = true,
                persistentStrip = true,
            ),
        )
    }

    @Test
    fun `first presentation timeout requests one cold visible rebuild`() {
        val lifecycle = readyParkedLifecycle()
        lifecycle.toggle()

        assertEquals(REBUILD_VISIBLE, lifecycle.onPresentationTimeout())
        assertEquals(PRESENTING, lifecycle.state.phase)
        assertFalse(lifecycle.state.hasCompositeFrame)
        assertTrue(lifecycle.state.loadingVisible)
        assertNull(lifecycle.state.failureCode)
        assertEquals(REVEAL, lifecycle.onCompositeReady())
        assertEquals(VISIBLE, lifecycle.state.phase)
    }

    @Test
    fun `second presentation timeout records fixed failure without rebuilding again`() {
        val lifecycle = readyParkedLifecycle()
        lifecycle.toggle()
        lifecycle.onPresentationTimeout()

        assertEquals(NONE, lifecycle.onPresentationTimeout())
        assertEquals(PRESENTING, lifecycle.state.phase)
        assertTrue(lifecycle.state.loadingVisible)
        assertEquals(StripOverlayLifecycle.PRESENTATION_TIMEOUT, lifecycle.state.failureCode)
    }

    @Test
    fun `cold rebuild allowance resets for the next presentation`() {
        val lifecycle = readyParkedLifecycle()
        lifecycle.toggle()
        assertEquals(REBUILD_VISIBLE, lifecycle.onPresentationTimeout())
        lifecycle.onCompositeReady()
        lifecycle.toggle()
        lifecycle.toggle()

        assertEquals(REBUILD_VISIBLE, lifecycle.onPresentationTimeout())
        assertNull(lifecycle.state.failureCode)
    }

    @Test
    fun `signature replacement destroy and re-prewarm never reuse a trace id`() {
        val ids = StripTraceIdSequence()
        val first = StripOverlayLifecycle()
        val firstPrewarm = ids.allocateFor(first.prewarm())
        first.destroy()
        val replacement = StripOverlayLifecycle()
        val replacementPrewarm = ids.allocateFor(replacement.prewarm())

        assertEquals(1L, firstPrewarm)
        assertEquals(2L, replacementPrewarm)
    }

    @Test
    fun `timeout rebuild owns a newer trace id than the failed presentation`() {
        val ids = StripTraceIdSequence()
        val lifecycle = readyParkedLifecycle()
        val presentation = ids.allocateFor(lifecycle.present())
        val rebuild = ids.allocateFor(lifecycle.onPresentationTimeout())

        assertEquals(1L, presentation)
        assertEquals(2L, rebuild)
    }

    @Test
    fun `prewarm present and timeout rebuild each own a fresh monotonic trace id`() {
        val ids = StripTraceIdSequence()
        val lifecycle = StripOverlayLifecycle()

        val prewarm = ids.allocateFor(lifecycle.prewarm())
        assertEquals(StripOverlayLifecycle.Command.PARK, lifecycle.onCompositeReady())
        val presentation = ids.allocateFor(lifecycle.present())
        val rebuild = ids.allocateFor(lifecycle.onPresentationTimeout())

        assertEquals(listOf(1L, 2L, 3L), listOf(prewarm, presentation, rebuild))
        assertNull(ids.allocateFor(StripOverlayLifecycle.Command.REVEAL))
    }

    @Test
    fun `audio trace uses bridge capture time instead of delayed main handling time`() {
        val mainHandledElapsedMs = 180L
        val elapsed = StripAudioTracePolicy.elapsedFor(
            reportedPresentationId = 3L,
            currentPresentationId = 3L,
            recordedPhases = setOf("revealed"),
            capturedAtMs = 130L,
            traceStartedAtMs = 0L,
            revealedElapsedMs = 120L,
        )

        assertEquals(130L, elapsed)
        assertFalse(elapsed == mainHandledElapsedMs)
    }

    @Test
    fun `audio trace ignores stale and pre-reveal events and clamps early capture to reveal`() {
        assertNull(StripAudioTracePolicy.elapsedFor(2L, 3L, setOf("revealed"), 130L, 0L, 120L))
        assertNull(StripAudioTracePolicy.elapsedFor(3L, 3L, emptySet(), 130L, 0L, 120L))
        assertNull(StripAudioTracePolicy.elapsedFor(3L, 3L, null, 130L, 0L, 120L))
        assertEquals(
            120L,
            StripAudioTracePolicy.elapsedFor(3L, 3L, setOf("revealed"), 110L, 0L, 120L),
        )
    }

    @Test
    fun `rebuild removes old window before closing old trace and requesting replacement`() {
        val events = mutableListOf<String>()

        StripRebuildOrder.execute(
            removeOld = { events += "remove_old" },
            closeOldTrace = { events += "destroyed_old" },
            beginNewTrace = { events += "request_new" },
            createNew = { events += "create_new" },
        )

        assertEquals(
            listOf("remove_old", "destroyed_old", "request_new", "create_new"),
            events,
        )
    }

    private fun readyParkedLifecycle(): StripOverlayLifecycle =
        StripOverlayLifecycle().also {
            it.prewarm()
            it.onCompositeReady()
        }

    private fun visibleLifecycle(): StripOverlayLifecycle =
        readyParkedLifecycle().also {
            it.toggle()
            it.onCompositeReady()
        }
}
