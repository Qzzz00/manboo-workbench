package com.llm.live2d

import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** Selects the persistent lifecycle only for the accepted handheld Figma strip. */
enum class OverlayStartMode { PERSISTENT_STRIP, EPHEMERAL }

object OverlayStartPolicy {
    fun modeFor(petQuery: String): OverlayStartMode {
        val isHandheldStrip = petQuery.split('&').any { pair ->
            val separator = pair.indexOf('=')
            if (separator < 0) return@any false
            decode(pair.substring(0, separator)) == "stripUi" &&
                decode(pair.substring(separator + 1)) == "figma-handheld"
        }
        return if (isHandheldStrip) OverlayStartMode.PERSISTENT_STRIP else OverlayStartMode.EPHEMERAL
    }

    private fun decode(value: String): String? =
        try {
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())
        } catch (_: IllegalArgumentException) {
            null
        }
}

enum class OverlayLaunchRequest { START, PREWARM, SAVE_ONLY }

data class OverlayLaunchBehavior(
    val persistStripParams: Boolean,
    val startService: Boolean,
    val moveTaskToBack: Boolean,
)

object OverlayLaunchPolicy {
    fun forRequest(
        request: OverlayLaunchRequest,
        fixed: Boolean,
        persistentStrip: Boolean = false,
    ): OverlayLaunchBehavior =
        when (request) {
            OverlayLaunchRequest.START -> OverlayLaunchBehavior(
                persistStripParams = persistentStrip,
                startService = true,
                moveTaskToBack = !fixed,
            )
            OverlayLaunchRequest.PREWARM -> OverlayLaunchBehavior(
                persistStripParams = true,
                startService = true,
                moveTaskToBack = false,
            )
            OverlayLaunchRequest.SAVE_ONLY -> OverlayLaunchBehavior(
                persistStripParams = true,
                startService = false,
                moveTaskToBack = false,
            )
        }
}

enum class StripKeyAction { PARK, STOP_EPHEMERAL, IGNORE, PRESENT_WARM, START_COLD }

object StripKeyActionPolicy {
    fun choose(
        overlayRunning: Boolean,
        overlayVisible: Boolean,
        persistentStrip: Boolean,
        aibooForeground: Boolean,
        hasSavedIntent: Boolean,
    ): StripKeyAction {
        if (overlayRunning && !persistentStrip) return StripKeyAction.STOP_EPHEMERAL
        if (overlayVisible) {
            return if (persistentStrip) StripKeyAction.PARK else StripKeyAction.STOP_EPHEMERAL
        }
        if (aibooForeground) return StripKeyAction.IGNORE
        if (overlayRunning && persistentStrip) return StripKeyAction.PRESENT_WARM
        return if (hasSavedIntent) StripKeyAction.START_COLD else StripKeyAction.IGNORE
    }
}

enum class StripParkExecution { KEEP_WARMING_HIDDEN, PAUSE_PARKED }

object StripParkPolicy {
    fun forPhase(phase: StripOverlayLifecycle.Phase): StripParkExecution =
        if (phase == StripOverlayLifecycle.Phase.WARMING_HIDDEN) {
            StripParkExecution.KEEP_WARMING_HIDDEN
        } else {
            StripParkExecution.PAUSE_PARKED
        }
}

object StripFrameOwnershipPolicy {
    fun accept(
        expectedPresentationId: Long,
        currentPresentationId: Long,
        sourceIsCurrentWindow: Boolean,
        phase: StripOverlayLifecycle.Phase,
    ): Boolean = expectedPresentationId == currentPresentationId &&
        sourceIsCurrentWindow &&
        phase == StripOverlayLifecycle.Phase.PRESENTING
}

enum class StripFrameWaitSource { NATIVE_COMPOSITE, WEBVIEW_VISUAL_STATE }

object StripFrameWaitPolicy {
    fun forRenderer(nativeControllerAttached: Boolean): StripFrameWaitSource =
        if (nativeControllerAttached) {
            StripFrameWaitSource.NATIVE_COMPOSITE
        } else {
            StripFrameWaitSource.WEBVIEW_VISUAL_STATE
        }
}

/** Accepts the first frame callback owned by one still-current presentation. */
class StripFrameCompletionGate(
    private val expectedPresentationId: Long,
) {
    private var completed = false

    fun accept(
        currentPresentationId: Long,
        sourceIsCurrentWindow: Boolean,
        phase: StripOverlayLifecycle.Phase,
    ): Boolean {
        if (completed || !StripFrameOwnershipPolicy.accept(
                expectedPresentationId = expectedPresentationId,
                currentPresentationId = currentPresentationId,
                sourceIsCurrentWindow = sourceIsCurrentWindow,
                phase = phase,
            )
        ) return false
        completed = true
        return true
    }
}

/** One service-lifetime sequence; only commands that begin renderer work receive a new trace ID. */
class StripTraceIdSequence {
    private var lastId = 0L

    fun allocateFor(command: StripOverlayLifecycle.Command): Long? = when (command) {
        StripOverlayLifecycle.Command.CREATE_HIDDEN,
        StripOverlayLifecycle.Command.SHOW_LOADING,
        StripOverlayLifecycle.Command.RESUME_HIDDEN,
        StripOverlayLifecycle.Command.REBUILD_VISIBLE,
        -> ++lastId
        else -> null
    }
}

/** Audio timing belongs to the current service trace and cannot precede the visible reveal. */
object StripAudioTracePolicy {
    fun elapsedFor(
        reportedPresentationId: Long,
        currentPresentationId: Long,
        recordedPhases: Set<String>?,
        capturedAtMs: Long,
        traceStartedAtMs: Long,
        revealedElapsedMs: Long?,
    ): Long? {
        if (reportedPresentationId != currentPresentationId) return null
        if (recordedPhases?.contains("revealed") != true || revealedElapsedMs == null) return null
        val capturedElapsedMs = (capturedAtMs - traceStartedAtMs).coerceAtLeast(0L)
        return maxOf(capturedElapsedMs, revealedElapsedMs.coerceAtLeast(0L))
    }
}

/** Keeps replacement trace events on the same side of the real old/new window boundaries. */
object StripRebuildOrder {
    fun execute(
        removeOld: () -> Unit,
        closeOldTrace: () -> Unit,
        beginNewTrace: () -> Unit,
        createNew: () -> Unit,
    ) {
        removeOld()
        closeOldTrace()
        beginNewTrace()
        createNew()
    }
}

enum class OverlayReadyRoute { IGNORE, PERSISTENT_STRIP, EPHEMERAL }

object OverlayReadyOwnershipPolicy {
    fun route(
        sourceIsCurrentWindow: Boolean,
        persistentStrip: Boolean,
    ): OverlayReadyRoute {
        if (!sourceIsCurrentWindow) return OverlayReadyRoute.IGNORE
        return if (persistentStrip) {
            OverlayReadyRoute.PERSISTENT_STRIP
        } else {
            OverlayReadyRoute.EPHEMERAL
        }
    }
}

/**
 * Pure state reducer for the persistent handheld bottom strip.
 *
 * Android window/WebView mutations are deliberately kept out of this class. The foreground service
 * executes the returned command on its main thread, making timing and retry behavior deterministic.
 */
class StripOverlayLifecycle {
    enum class Phase { COLD, WARMING_HIDDEN, READY_PARKED, PRESENTING, VISIBLE }

    enum class Command {
        CREATE_HIDDEN,
        SHOW_LOADING,
        RESUME_HIDDEN,
        REVEAL,
        PARK,
        REBUILD_VISIBLE,
        DESTROY,
        NONE,
    }

    data class State(
        val phase: Phase,
        val hasCompositeFrame: Boolean,
        val loadingVisible: Boolean = false,
        val failureCode: String? = null,
        val rebuildAttempted: Boolean = false,
    )

    var state = State(Phase.COLD, hasCompositeFrame = false)
        private set

    fun prewarm(): Command = when (state.phase) {
        Phase.COLD -> {
            state = State(Phase.WARMING_HIDDEN, hasCompositeFrame = false)
            Command.CREATE_HIDDEN
        }
        else -> Command.NONE
    }

    /** Present without applying F10's hide branch; used by a normal service start intent. */
    fun present(): Command = when (state.phase) {
        Phase.COLD -> {
            state = State(Phase.PRESENTING, hasCompositeFrame = false, loadingVisible = true)
            Command.SHOW_LOADING
        }
        Phase.WARMING_HIDDEN -> {
            state = state.copy(
                phase = Phase.PRESENTING,
                loadingVisible = true,
                failureCode = null,
                rebuildAttempted = false,
            )
            Command.SHOW_LOADING
        }
        Phase.READY_PARKED -> {
            state = state.copy(
                phase = Phase.PRESENTING,
                loadingVisible = false,
                failureCode = null,
                rebuildAttempted = false,
            )
            Command.RESUME_HIDDEN
        }
        Phase.PRESENTING, Phase.VISIBLE -> Command.NONE
    }

    fun toggle(): Command = when (state.phase) {
        Phase.COLD -> present()
        Phase.WARMING_HIDDEN -> present()
        Phase.READY_PARKED -> present()
        Phase.PRESENTING -> {
            state = if (state.hasCompositeFrame) {
                state.copy(phase = Phase.READY_PARKED, loadingVisible = false, failureCode = null)
            } else {
                state.copy(phase = Phase.WARMING_HIDDEN, loadingVisible = false, failureCode = null)
            }
            Command.PARK
        }
        Phase.VISIBLE -> {
            state = state.copy(phase = Phase.READY_PARKED, loadingVisible = false, failureCode = null)
            Command.PARK
        }
    }

    fun onCompositeReady(): Command = when (state.phase) {
        Phase.WARMING_HIDDEN -> {
            state = state.copy(
                phase = Phase.READY_PARKED,
                hasCompositeFrame = true,
                loadingVisible = false,
                failureCode = null,
            )
            Command.PARK
        }
        Phase.PRESENTING -> {
            state = state.copy(
                phase = Phase.VISIBLE,
                hasCompositeFrame = true,
                loadingVisible = false,
                failureCode = null,
            )
            Command.REVEAL
        }
        else -> Command.NONE
    }

    fun onPresentationTimeout(): Command {
        if (state.phase != Phase.PRESENTING) return Command.NONE
        if (state.rebuildAttempted) {
            state = state.copy(failureCode = PRESENTATION_TIMEOUT)
            return Command.NONE
        }
        state = state.copy(
            hasCompositeFrame = false,
            loadingVisible = true,
            failureCode = null,
            rebuildAttempted = true,
        )
        return Command.REBUILD_VISIBLE
    }

    fun destroy(): Command {
        state = State(Phase.COLD, hasCompositeFrame = false)
        return Command.DESTROY
    }

    companion object {
        const val PRESENTATION_TIMEOUT = "strip_presentation_timeout"
    }
}
