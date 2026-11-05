package com.llm.live2d

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import com.llm.live2d.nativelive2d.LifecycleTraceFormatter
import java.util.concurrent.CopyOnWriteArrayList

/** Foreground owner for ordinary pet overlays and the persistent handheld bottom strip. */
class Live2DOverlayService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var window: OverlayWindow? = null
    private var tapWindow: StrategistTapWindow? = null
    private var windowSignature: String? = null
    private var stripLifecycle: StripOverlayLifecycle? = null
    private var stripIntent: Intent? = null
    private var presentationId = 0L
    private val traceIds = StripTraceIdSequence()
    private var presentationTimeout: Runnable? = null
    private var persistentStrip = false
    /** 只有普通、非固定桌宠随 App 前台隐藏；电台固定浮窗和掌机底条允许同屏。 */
    private var autoHideWithApp = false
    private val lifecycleTraces = linkedMapOf<Long, StripLifecycleTrace>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        // START_STICKY replay has no authoritative JS parameters and must never invent a pet.
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        instance = this
        isRunning = true
        val spec = OverlaySpec.from(intent)
        when (OverlayStartPolicy.modeFor(spec.petQuery)) {
            OverlayStartMode.PERSISTENT_STRIP -> startPersistentStrip(intent, spec)
            OverlayStartMode.EPHEMERAL -> startEphemeralOverlay(spec)
        }
        return START_NOT_STICKY
    }

    /** Start hidden prewarming. The service entry point already owns foreground-service startup. */
    fun prewarm(intent: Intent) = onMain {
        val spec = OverlaySpec.from(intent)
        if (OverlayStartPolicy.modeFor(spec.petQuery) != OverlayStartMode.PERSISTENT_STRIP) return@onMain
        startPersistentStrip(intent, spec, forceWarmOnly = true)
    }

    /** Present the warm strip; safe to call from the accessibility service. */
    fun present() = onMain { presentOnMain() }

    /** F10 park path. Ordinary overlays retain their historic full-stop semantics. */
    fun park() = onMain {
        if (!persistentStrip) {
            destroyOverlayOnMain()
            stopSelf()
            return@onMain
        }
        val command = stripLifecycle?.toggle() ?: return@onMain
        executeStripCommand(command)
    }

    /** Full release used for the handoff back to the home renderer. */
    fun destroyOverlay() = onMain {
        stripLifecycle?.destroy()
        destroyOverlayOnMain()
        stopSelf()
    }

    fun applyDimensions(widthDp: Int, aspect: String) = onMain {
        window?.applyDimensions(widthDp, aspect)
    }

    fun applyFraming(headScreenY: Double, faceScreenFrac: Double) = onMain {
        window?.applyFraming(headScreenY, faceScreenFrac)
    }

    override fun onDestroy() {
        cancelPresentationTimeout()
        stripLifecycle?.destroy()
        destroyOverlayOnMain()
        instance = null
        isRunning = false
        isVisible = false
        isPersistentStrip = false
        notifyStopped()
        super.onDestroy()
    }

    private fun startPersistentStrip(
        intent: Intent,
        spec: OverlaySpec,
        forceWarmOnly: Boolean = false,
    ) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val signatureChanged = window != null && spec.signature != windowSignature
        val resourcesMissing = persistentStrip && window == null
        if (!persistentStrip || signatureChanged || resourcesMissing) {
            cancelPresentationTimeout()
            destroyOverlayOnMain()
            stripLifecycle = StripOverlayLifecycle()
        }
        persistentStrip = true
        autoHideWithApp = false
        isPersistentStrip = true
        stripIntent = Intent(intent).apply { removeExtra(EXTRA_WARM_ONLY) }
        windowSignature = spec.signature
        window?.updateAuth(spec.token, spec.aibooToken)

        val warmOnly = forceWarmOnly || intent.getBooleanExtra(EXTRA_WARM_ONLY, false)
        if (warmOnly) {
            val command = stripLifecycle!!.prewarm()
            executeStripCommand(command)
        } else {
            presentOnMain()
        }
    }

    private fun startEphemeralOverlay(spec: OverlaySpec) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (persistentStrip || (window != null && spec.signature != windowSignature)) {
            cancelPresentationTimeout()
            destroyOverlayOnMain()
        }
        persistentStrip = false
        autoHideWithApp = !spec.fixed && !spec.touchThrough
        isPersistentStrip = false
        stripLifecycle = null
        stripIntent = null
        windowSignature = spec.signature
        if (window == null) {
            createWindow(spec).addToWindow()
            attachTapWindow(spec)
        } else {
            window?.updateAuth(spec.token, spec.aibooToken)
        }
        updatePetVisibilityOnMain()
    }

    /** MainActivity 生命周期回调入口：避免普通桌宠与 App 内 Live2D 同屏争用 Cubism。 */
    fun updatePetVisibility() = onMain(::updatePetVisibilityOnMain)

    private fun updatePetVisibilityOnMain() {
        if (persistentStrip) return
        val visible = !(autoHideWithApp && foregroundActivities > 0)
        window?.setVisible(visible)
        isVisible = visible
    }

    private fun presentOnMain() {
        check(Looper.myLooper() == Looper.getMainLooper())
        val lifecycle = stripLifecycle ?: return
        val command = lifecycle.present()
        if (command == StripOverlayLifecycle.Command.NONE) return
        executeStripCommand(command)
    }

    private fun executeStripCommand(command: StripOverlayLifecycle.Command) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (command != StripOverlayLifecycle.Command.REBUILD_VISIBLE) allocateLifecycleTrace(command)
        when (command) {
            StripOverlayLifecycle.Command.CREATE_HIDDEN -> {
                val spec = currentStripSpec() ?: return
                ensureWindow(spec).warmHidden(presentationId)
                removeTapWindow()
                isVisible = false
            }
            StripOverlayLifecycle.Command.SHOW_LOADING -> {
                val spec = currentStripSpec() ?: return
                removeTapWindow()
                ensureWindow(spec).showLoading(presentationId)
                isVisible = true
                schedulePresentationTimeout(presentationId)
            }
            StripOverlayLifecycle.Command.RESUME_HIDDEN -> {
                val spec = currentStripSpec() ?: return
                removeTapWindow()
                val expectedId = presentationId
                isVisible = true
                val source = ensureWindow(spec)
                val completionGate = StripFrameCompletionGate(expectedId)
                source.resumeForPresentation(
                    expectedId,
                ) {
                    val phase = stripLifecycle?.state?.phase ?: return@resumeForPresentation
                    if (!completionGate.accept(
                            currentPresentationId = presentationId,
                            sourceIsCurrentWindow = window === source,
                            phase = phase,
                        )
                    ) return@resumeForPresentation
                    traceLifecyclePhase(expectedId, "composite_ready")
                    executeStripCommand(stripLifecycle?.onCompositeReady() ?: return@resumeForPresentation)
                }
                schedulePresentationTimeout(expectedId)
            }
            StripOverlayLifecycle.Command.REVEAL -> {
                cancelPresentationTimeout()
                val revealedElapsedMs = lifecycleElapsed(presentationId) ?: 0L
                window?.reveal(presentationId, revealedElapsedMs)
                traceLifecyclePhase(presentationId, "revealed", revealedElapsedMs)
                currentStripSpec()?.let(::attachTapWindow)
                isVisible = true
                readyListener?.invoke()
            }
            StripOverlayLifecycle.Command.PARK -> {
                cancelPresentationTimeout()
                removeTapWindow()
                isVisible = false
                when (stripLifecycle?.state?.phase?.let(StripParkPolicy::forPhase)) {
                    StripParkExecution.KEEP_WARMING_HIDDEN -> window?.warmHidden(presentationId)
                    StripParkExecution.PAUSE_PARKED, null -> {
                        val expectedId = presentationId
                        window?.parkOffscreen { traceLifecyclePhase(expectedId, "parked") }
                    }
                }
            }
            StripOverlayLifecycle.Command.REBUILD_VISIBLE -> rebuildVisibleStrip()
            StripOverlayLifecycle.Command.DESTROY -> destroyOverlayOnMain()
            StripOverlayLifecycle.Command.NONE -> Unit
        }
    }

    private fun onInitialCompositeReady(source: OverlayWindow) {
        if (window !== source || !persistentStrip) return
        traceLifecyclePhase(presentationId, "composite_ready")
        executeStripCommand(stripLifecycle?.onCompositeReady() ?: return)
    }

    private fun rebuildVisibleStrip() {
        val spec = currentStripSpec() ?: return
        val oldTraceId = presentationId
        removeTapWindow()
        StripRebuildOrder.execute(
            removeOld = {
                window?.removeFromWindow()
                window = null
            },
            closeOldTrace = { closeLifecycleTrace(oldTraceId) },
            beginNewTrace = { allocateLifecycleTrace(StripOverlayLifecycle.Command.REBUILD_VISIBLE) },
            createNew = {
                // Keep the accepted loading state requested by the reducer while replacing stale GL/WebView.
                ensureWindow(spec).showLoading(presentationId)
            },
        )
        isVisible = true
        schedulePresentationTimeout(presentationId)
    }

    private fun schedulePresentationTimeout(expectedId: Long) {
        cancelPresentationTimeout()
        val timeout = Runnable {
            if (expectedId != presentationId) return@Runnable
            val lifecycle = stripLifecycle ?: return@Runnable
            val command = lifecycle.onPresentationTimeout()
            if (command == StripOverlayLifecycle.Command.NONE &&
                lifecycle.state.failureCode == StripOverlayLifecycle.PRESENTATION_TIMEOUT
            ) {
                // Failure code remains in reducer state; no lifecycle phase is fabricated for it.
            }
            executeStripCommand(command)
        }
        presentationTimeout = timeout
        mainHandler.postDelayed(timeout, PRESENTATION_TIMEOUT_MS)
    }

    private fun cancelPresentationTimeout() {
        presentationTimeout?.let(mainHandler::removeCallbacks)
        presentationTimeout = null
    }

    private fun currentStripSpec(): OverlaySpec? = stripIntent?.let(OverlaySpec::from)

    private fun ensureWindow(spec: OverlaySpec): OverlayWindow =
        window ?: createWindow(spec)

    private fun createWindow(spec: OverlaySpec): OverlayWindow {
        val created = OverlayWindow(
            this,
            spec.avatarId,
            spec.petQuery,
            spec.widthDp,
            spec.aspect,
            spec.token,
            spec.fixed,
            spec.xPx,
            spec.yPx,
            spec.widthPx,
            spec.heightPx,
            spec.touchThrough,
            spec.webTouchable,
            spec.aibooToken,
        )
        window = created
        windowSignature = spec.signature

        fun openMain(openSettings: Boolean) {
            destroyOverlayOnMain()
            val main = Intent(this, MainActivity::class.java)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_HOME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(MainActivity.EXTRA_OPEN_HANDHELD_SETTINGS, openSettings)
                .putExtra(MainActivity.EXTRA_HANDHELD_SETTINGS_ORIGIN, "game")
            stopSelf()
            mainHandler.post { startActivity(main) }
        }

        created.onLongPress = { openMain(false) }
        created.onClose = { stopSelf() }
        created.onOpenSettings = { openMain(true) }
        created.onExitGame = { openMain(false) }
        created.onReady = {
            when (OverlayReadyOwnershipPolicy.route(window === created, persistentStrip)) {
                OverlayReadyRoute.IGNORE -> Unit
                OverlayReadyRoute.PERSISTENT_STRIP -> onInitialCompositeReady(created)
                OverlayReadyRoute.EPHEMERAL -> readyListener?.invoke()
            }
        }
        created.onNativeHostResumed = { id -> traceLifecyclePhase(id, "host_resumed") }
        created.onAudioStarted = { id, eventAtMs -> onStripAudioStarted(id, eventAtMs) }
        return created
    }

    private fun attachTapWindow(spec: OverlaySpec) {
        removeTapWindow()
        if (!spec.touchThrough) return
        val x = spec.xPx ?: return
        val y = spec.yPx ?: return
        val height = spec.heightPx ?: return
        if (spec.widthPx == null) return
        tapWindow = StrategistTapWindow(this, x, y, height).also { tap ->
            tap.onTap = { window?.pushTap("tap") }
            tap.onHoldStart = { window?.pushTap("holdStart") }
            tap.onHoldEnd = { window?.pushTap("holdEnd") }
            tap.addToWindow()
        }
    }

    private fun removeTapWindow() {
        tapWindow?.removeFromWindow()
        tapWindow = null
    }

    private fun destroyOverlayOnMain() {
        check(Looper.myLooper() == Looper.getMainLooper())
        val destroyedTraceId = presentationId.takeIf { persistentStrip && window != null }
        cancelPresentationTimeout()
        removeTapWindow()
        window?.removeFromWindow()
        window = null
        windowSignature = null
        isVisible = false
        destroyedTraceId?.let {
            closeLifecycleTrace(it)
        }
    }

    private fun beginLifecycleTrace(id: Long) {
        lifecycleTraces[id] = StripLifecycleTrace(SystemClock.elapsedRealtime())
        while (lifecycleTraces.size > MAX_LIFECYCLE_TRACES) {
            lifecycleTraces.remove(lifecycleTraces.keys.first())
        }
        traceLifecyclePhase(id, "request")
    }

    private fun allocateLifecycleTrace(command: StripOverlayLifecycle.Command) {
        traceIds.allocateFor(command)?.let { id ->
            presentationId = id
            beginLifecycleTrace(id)
        }
    }

    private fun onStripAudioStarted(id: Long, eventAtMs: Long) {
        val trace = lifecycleTraces[id]
        val elapsedMs = StripAudioTracePolicy.elapsedFor(
            reportedPresentationId = id,
            currentPresentationId = presentationId,
            recordedPhases = trace?.phases,
            capturedAtMs = eventAtMs,
            traceStartedAtMs = trace?.startedAtMs ?: return,
            revealedElapsedMs = trace.revealedElapsedMs,
        ) ?: return
        traceLifecyclePhase(id, "audio_started", elapsedMs)
    }

    private fun lifecycleElapsed(id: Long): Long? = lifecycleTraces[id]?.let { trace ->
        (SystemClock.elapsedRealtime() - trace.startedAtMs).coerceAtLeast(0L)
    }

    private fun traceLifecyclePhase(id: Long, phase: String, elapsedOverrideMs: Long? = null) {
        val trace = lifecycleTraces[id] ?: return
        if (trace.phases.contains(phase)) return
        val elapsedMs = elapsedOverrideMs?.coerceAtLeast(0L) ?: lifecycleElapsed(id) ?: return
        trace.phases.add(phase)
        if (phase == "revealed") trace.revealedElapsedMs = elapsedMs
        try {
            Log.i(
                TAG,
                LifecycleTraceFormatter.format(
                    "[handheld-strip]",
                    id,
                    phase,
                    elapsedMs,
                ),
            )
        } catch (_: RuntimeException) {
            // Instrumentation must never own service control flow.
        }
    }

    private fun closeLifecycleTrace(id: Long) {
        traceLifecyclePhase(id, "destroyed")
        lifecycleTraces.remove(id)
    }

    private data class StripLifecycleTrace(
        val startedAtMs: Long,
        val phases: MutableSet<String> = linkedSetOf(),
        var revealedElapsedMs: Long? = null,
    )

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else mainHandler.post(action)
    }

    private fun startForegroundCompat() {
        val channelId = "aiboo_pet_overlay"
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(channelId) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(channelId, "桌宠浮窗", NotificationManager.IMPORTANCE_MIN),
                )
            }
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        val notification: Notification = builder
            .setContentTitle("桌宠运行中")
            .setSmallIcon(applicationInfo.icon)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                1,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(1, notification)
        }
    }

    private data class OverlaySpec(
        val avatarId: String,
        val petQuery: String,
        val widthDp: Int,
        val aspect: String,
        val token: String,
        val aibooToken: String,
        val fixed: Boolean,
        val xPx: Int?,
        val yPx: Int?,
        val widthPx: Int?,
        val heightPx: Int?,
        val touchThrough: Boolean,
        val webTouchable: Boolean,
    ) {
        // Secrets and user content never enter the signature. Query equality is represented only by
        // an in-memory hash used to decide whether visual/layout parameters changed.
        val signature: String = listOf(
            avatarId,
            petQuery.hashCode(),
            widthDp,
            aspect,
            fixed,
            xPx,
            yPx,
            widthPx,
            heightPx,
            touchThrough,
            webTouchable,
        ).joinToString("|")

        companion object {
            fun from(intent: Intent): OverlaySpec = OverlaySpec(
                avatarId = intent.getStringExtra("avatarId") ?: "yumi",
                petQuery = intent.getStringExtra("petQuery") ?: "",
                widthDp = intent.getIntExtra("widthDp", 260),
                aspect = intent.getStringExtra("aspect") ?: "3:4",
                token = intent.getStringExtra("token") ?: "",
                aibooToken = intent.getStringExtra("aibooToken") ?: "",
                fixed = intent.getBooleanExtra("fixed", false),
                xPx = intent.getIntExtra("xPx", -1).takeIf { it >= 0 },
                yPx = intent.getIntExtra("yPx", -1).takeIf { it >= 0 },
                widthPx = intent.getIntExtra("widthPx", -1).takeIf { it > 0 },
                heightPx = intent.getIntExtra("heightPx", -1).takeIf { it > 0 },
                touchThrough = intent.getBooleanExtra("touchThrough", false),
                webTouchable = intent.getBooleanExtra("webTouchable", false),
            )
        }
    }

    companion object {
        const val EXTRA_WARM_ONLY = "warmOnly"
        private const val PRESENTATION_TIMEOUT_MS = 3000L
        private const val MAX_LIFECYCLE_TRACES = 8
        private const val TAG = "Live2DOverlayService"

        @Volatile var isRunning = false
        @Volatile var isVisible = false
        @Volatile var isPersistentStrip = false
        @Volatile var instance: Live2DOverlayService? = null
        @JvmField @Volatile var foregroundActivities = 0
        @JvmField @Volatile var activityWatcherRegistered = false
        private val stopListeners = CopyOnWriteArrayList<() -> Unit>()

        @JvmStatic fun onAppForegroundChanged() {
            instance?.updatePetVisibility()
        }

        fun whenStopped(listener: () -> Unit) {
            if (!isRunning && instance == null) {
                listener()
                return
            }
            stopListeners += listener
            if (!isRunning && instance == null && stopListeners.remove(listener)) listener()
        }

        private fun notifyStopped() {
            val listeners = stopListeners.toList()
            stopListeners.clear()
            listeners.forEach { listener ->
                try {
                    listener()
                } catch (_: Throwable) {
                    // One stale Capacitor call must not block other stop waiters.
                }
            }
        }

        var readyListener: (() -> Unit)? = null
    }
}
