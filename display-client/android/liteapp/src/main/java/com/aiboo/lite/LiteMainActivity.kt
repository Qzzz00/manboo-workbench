package com.aiboo.lite

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.aiboo.lite.avatar.AvatarRepo
import com.aiboo.lite.avatar.aspectFitLayout
import com.aiboo.lite.chat.ChatEngine
import com.aiboo.lite.chat.TtsPlayer
import com.aiboo.lite.chat.VoiceInput
import com.aiboo.lite.net.ApiClient
import com.aiboo.lite.net.ApiException
import com.aiboo.lite.net.AuthStore
import com.llm.live2d.nativelive2d.NativeLive2DController
import org.json.JSONArray
import org.json.JSONObject

/**
 * 低端机纯原生摆件主界面：启动即 GL 渲染 Live2D 角色，零 WebView。
 *
 * M1 骨架 / M2 摆件+摸头 / M3 聊天(文字→LLM→TTS 口型) / M4 按住说话 / M5 角色切换+设置。
 * 手势：单击=摸头反应+视线跟随；长按=设置页。
 */
class LiteMainActivity : Activity() {

    private companion object {
        const val TAG = "AibooLite"

        /** 聊天态取景：半身特写（主 App 同款陪伴感）。模型高=2.1 屏高，底边压到屏下方。
         *  bottom 1.98：U1 Pro 实测 1.9 时猫耳尖被上沿裁掉，下挪 8% 屏高露全头顶。 */
        const val CHAT_HEIGHT_FRAC = 2.1
        const val CHAT_BOTTOM_FRAC = 1.98

        /** 摆件态取景：全身站桩（充电闲置/屏保的展示语义）。 */
        const val PENDANT_HEIGHT_FRAC = 0.92
        const val PENDANT_BOTTOM_FRAC = 0.97

        /** 充电中无操作多久切摆件态。 */
        const val PENDANT_IDLE_MS = 60_000L
    }

    private lateinit var controller: NativeLive2DController
    private lateinit var ttsPlayer: TtsPlayer
    private lateinit var bubble: TextView
    private lateinit var input: EditText
    private lateinit var sendButton: TextView
    private lateinit var micButton: TextView
    private lateinit var composerBar: LinearLayout
    private lateinit var compactClock: PendantView
    private lateinit var pendantClock: PendantView

    private var chatEngine: ChatEngine? = null
    private var currentAvatar: AvatarRepo.LocalAvatar? = null
    private var motionPlan: AvatarRepo.MotionPlan? = null
    private var loadedFps = 15

    /** 模型画布宽高比（showModel 回调回填），构图换算用。 */
    private var canvasAspect = 0.5

    /** 摆件态标志：true=大钟+全身展示；任何触摸退回聊天态。 */
    private var pendantMode = false
    private var charging = false
    private val pendantIdleRunnable = Runnable { if (charging && !pendantMode) enterPendantMode() }

    private val voiceInput = VoiceInput()
    private val random = java.util.Random()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var bubbleHideAt = 0L
    private var sending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ApiClient.init(this)
        AvatarRepo.init(this)

        // 摆件形态：常亮 + 沉浸全屏 + 锁屏上照常显示（插电摆桌时不因锁屏消失）
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (android.os.Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        enterImmersive()

        val root = FrameLayout(this)
        setContentView(root)

        // GLSurfaceView z-order 在窗口面之下（SurfaceView 打洞机制）：窗口背景必须透明
        // 才能露出 GL 层——theme 里保持黑（冷启动不闪桌面），进来后运行时切透明。
        window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))

        controller = NativeLive2DController(this)
        ttsPlayer = TtsPlayer(this, controller)

        if (!controller.isCoreAvailable()) {
            Log.e(TAG, "Cubism core unavailable (ABI without .so?)")
            return
        }
        controller.attachUnderOnUiThread(
            root, 0,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        loadCurrentAvatar()

        buildPendant(root)
        buildBubble(root)
        buildComposer(root)
        bindTouch(root)
    }

    // ---- 角色加载/切换 ----

    private fun loadCurrentAvatar() {
        val avatar = AvatarRepo.resolve(AvatarRepo.currentAvatarId) ?: AvatarRepo.BUILTIN
        val settingsJson = try {
            com.aiboo.lite.avatar.readModelJson(this, avatar.modelJson)
        } catch (t: Throwable) {
            Log.e(TAG, "model json read failed: ${avatar.modelJson}", t)
            if (!avatar.builtin) {
                AvatarRepo.currentAvatarId = AvatarRepo.BUILTIN.id
                loadCurrentAvatar()
            }
            return
        }
        val plan = AvatarRepo.motionPlan(avatar, settingsJson)
        val fps = AvatarRepo.targetFps

        currentAvatar = avatar
        motionPlan = plan
        loadedFps = fps
        chatEngine = ChatEngine(avatar.id, avatar.personaPrompt)

        val opts = JSONObject().apply {
            put("settingsJson", settingsJson)
            put("modelDir", avatar.modelDir)
            plan.idleGroup?.let { put("idleMotionGroup", it) }
            if (plan.beatGroups.isNotEmpty()) put("idleBeatGroups", JSONArray(plan.beatGroups))
            put("targetFps", fps)
            put("backgroundColor", "#1A1A2E")
            put("layout", currentLayout())
        }
        controller.showModel(opts) { result, error ->
            if (result != null) {
                // 画布真实纵横比回填后重设构图（保比例换算需要它；此前用估值 0.5）
                val cw = result.optDouble("canvasWidthPx", 0.0)
                val ch = result.optDouble("canvasHeightPx", 0.0)
                if (cw > 0 && ch > 0) {
                    canvasAspect = cw / ch
                    mainHandler.post { controller.setLayout(currentLayout()) }
                }
                Log.i(TAG, "model ready: ${avatar.id} canvas=${cw.toInt()}x${ch.toInt()} params=${result.optJSONArray("params")?.length()}")
            } else {
                Log.e(TAG, "showModel failed: $error")
            }
        }
    }

    /** 当前形态的保比例构图。 */
    private fun currentLayout(): JSONObject {
        val dm = resources.displayMetrics
        return if (pendantMode) {
            aspectFitLayout(PENDANT_HEIGHT_FRAC, PENDANT_BOTTOM_FRAC, canvasAspect, dm.widthPixels, dm.heightPixels)
        } else {
            aspectFitLayout(CHAT_HEIGHT_FRAC, CHAT_BOTTOM_FRAC, canvasAspect, dm.widthPixels, dm.heightPixels)
        }
    }

    // ---- 聊天态 ↔ 摆件态 ----

    private fun enterPendantMode() {
        if (pendantMode) return
        pendantMode = true
        controller.setLayout(currentLayout())
        pendantClock.visibility = View.VISIBLE
        pendantClock.animate().alpha(1f).setDuration(400).start()
        listOf<View>(composerBar, compactClock).forEach { v ->
            v.animate().alpha(0f).setDuration(400).withEndAction { v.visibility = View.GONE }.start()
        }
        hideBubbleNow()
        hideIme()
    }

    private fun enterChatMode() {
        if (!pendantMode) return
        pendantMode = false
        controller.setLayout(currentLayout())
        pendantClock.animate().alpha(0f).setDuration(300)
            .withEndAction { pendantClock.visibility = View.GONE }.start()
        listOf<View>(composerBar, compactClock).forEach { v ->
            v.visibility = View.VISIBLE
            v.animate().alpha(1f).setDuration(300).start()
        }
    }

    /** 任何用户活动：重置摆件计时；若在摆件态则唤回聊天态。 */
    private fun onUserActivity() {
        mainHandler.removeCallbacks(pendantIdleRunnable)
        mainHandler.postDelayed(pendantIdleRunnable, PENDANT_IDLE_MS)
        if (pendantMode) enterChatMode()
    }

    // ---- 摆件 UI ----

    private fun buildPendant(root: FrameLayout) {
        // 宽度 MATCH_PARENT：WRAP_CONTENT 在部分机型上被量成默认字号宽（64sp 时钟遭截断），
        // 信息块无背景板，占满宽度视觉等价且彻底绕开该测量怪癖
        fun lp(topDp: Int) = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            leftMargin = dp(28)
            topMargin = dp(topDp)
        }
        // 聊天态：角落一行小字（不抢主页戏）
        compactClock = PendantView(this, compact = true)
        root.addView(compactClock, lp(40))
        // 摆件态：大钟，默认隐藏，充电闲置时浮现
        pendantClock = PendantView(this, compact = false).apply {
            visibility = View.GONE
            alpha = 0f
        }
        root.addView(pendantClock, lp(64))
    }

    /** 回复气泡：角色头旁浮动，读完淡出（摆件感，不做聊天列表）。 */
    private fun buildBubble(root: FrameLayout) {
        bubble = TextView(this).apply {
            visibility = View.GONE
            setTextColor(0xFF222233.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setLineSpacing(0f, 1.15f)
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(0xF2FFFFFF.toInt())
            }
            setPadding(dp(16), dp(11), dp(16), dp(11))
        }
        root.addView(
            bubble,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                // 半身特写下脸在上 1/3——气泡放胸口位置才不遮脸
                topMargin = (resources.displayMetrics.heightPixels * 0.44f).toInt()
                leftMargin = dp(32)
                rightMargin = dp(32)
            },
        )
    }

    private fun showBubble(text: String, autoHideMs: Long) {
        bubble.text = text
        bubble.visibility = View.VISIBLE
        bubble.alpha = 0f
        bubble.animate().alpha(1f).setDuration(160).start()
        val hideAt = System.currentTimeMillis() + autoHideMs
        bubbleHideAt = hideAt
        mainHandler.postDelayed({
            if (bubbleHideAt == hideAt) {
                bubble.animate().alpha(0f).setDuration(400)
                    .withEndAction { bubble.visibility = View.GONE }
                    .start()
            }
        }, autoHideMs)
    }

    private fun hideBubbleNow() {
        bubbleHideAt = 0L
        bubble.visibility = View.GONE
    }

    /** 底部聊天条：🎤按住说话 + 输入框 + 发送。未登录时先跳登录页。 */
    private fun buildComposer(root: FrameLayout) {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        composerBar = bar
        input = EditText(this).apply {
            hint = "和她说点什么…"
            setHintTextColor(0x59FFFFFF)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            maxLines = 3
            imeOptions = EditorInfo.IME_ACTION_SEND
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            background = GradientDrawable().apply {
                cornerRadius = dp(22).toFloat()
                setColor(0x30000000)
                setStroke(dp(1), 0x33FFFFFF)
            }
            setPadding(dp(18), dp(10), dp(18), dp(10))
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    submitChat()
                    true
                } else {
                    false
                }
            }
        }
        sendButton = TextView(this).apply {
            text = "发送"
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = GradientDrawable().apply {
                cornerRadius = dp(21).toFloat()
                setColor(0xE67C6BF0.toInt())
            }
            setPadding(dp(20), dp(10), dp(20), dp(10))
            setOnClickListener { submitChat() }
        }
        micButton = TextView(this).apply {
            text = "🎤"
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0x30000000)
                setStroke(dp(1), 0x33FFFFFF)
            }
            bindHoldToTalk(this)
        }
        bar.addView(
            micButton,
            LinearLayout.LayoutParams(dp(44), dp(44)).apply { rightMargin = dp(10) },
        )
        bar.addView(
            input,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        bar.addView(
            sendButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { leftMargin = dp(10) },
        )
        root.addView(
            bar,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.BOTTOM
                leftMargin = dp(20)
                rightMargin = dp(20)
                bottomMargin = dp(28)
            },
        )
    }

    // ---- 聊天 ----

    private fun submitChat() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        input.setText("")
        hideIme()
        sendChatText(text)
    }

    /** 文字与语音识别文本共用的聊天发送链路。 */
    private fun sendChatText(text: String) {
        if (sending || text.isEmpty()) return
        val engine = chatEngine ?: return
        val avatar = currentAvatar ?: return
        if (!AuthStore.loggedIn) {
            startActivity(Intent(this, LoginActivity::class.java))
            return
        }
        sending = true
        sendButton.alpha = 0.4f
        showBubble("…", 60_000L)

        ApiClient.io.execute {
            val result = runCatching { engine.send(text) }
            mainHandler.post {
                sending = false
                sendButton.alpha = 1f
                result.fold(
                    onSuccess = { reply ->
                        // 展示时长按字数走：阅读节奏 + TTS 播放（约 5 字/秒），下限 8s
                        val holdMs = (reply.reply.length * 200L + 4_000L).coerceAtLeast(8_000L)
                        showBubble(reply.reply, holdMs)
                        motionPlan?.emotionMotions?.get(reply.emotion)?.let { controller.playMotion(it) }
                        ttsPlayer.speak(reply.reply, reply.emotion, avatar.id)
                    },
                    onFailure = { e ->
                        val msg = e.message ?: "出错了"
                        showBubble(if (msg.contains("登录")) "$msg（点发送重新登录）" else msg, 6_000L)
                        if (msg.contains("登录")) AuthStore.clear()
                    },
                )
            }
        }
    }

    // ---- 按住说话 ----

    @Suppress("ClickableViewAccessibility")
    private fun bindHoldToTalk(button: TextView) {
        button.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (!AuthStore.loggedIn) {
                        startActivity(Intent(this, LoginActivity::class.java))
                        return@setOnTouchListener true
                    }
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) !=
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                    ) {
                        requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 1)
                        return@setOnTouchListener true
                    }
                    if (voiceInput.start()) {
                        v.alpha = 0.55f
                        showBubble("在听呢…松开发送", 60_000L)
                    } else {
                        showBubble("麦克风打不开", 4_000L)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    v.alpha = 1f
                    finishVoiceInput()
                }
                MotionEvent.ACTION_CANCEL -> {
                    v.alpha = 1f
                    voiceInput.cancel()
                    hideBubbleNow()
                }
            }
            true
        }
    }

    private fun finishVoiceInput() {
        if (!voiceInput.isRecording) return
        val wav = voiceInput.stop()
        if (wav == null) {
            showBubble("说话时间太短啦", 3_000L)
            return
        }
        showBubble("听懂中…", 60_000L)
        ApiClient.io.execute {
            val result = runCatching {
                val audio = android.util.Base64.encodeToString(wav, android.util.Base64.NO_WRAP)
                ApiClient.postJson("/ai/asr", JSONObject().put("audio", audio))
                    .optString("text", "").trim()
            }
            mainHandler.post {
                result.fold(
                    onSuccess = { text ->
                        if (text.isEmpty()) {
                            showBubble("没听清，再试一次？", 4_000L)
                        } else {
                            sendChatText(text)
                        }
                    },
                    onFailure = { e ->
                        val msg = if (e is ApiException && e.status == 422) "没听清，再试一次？" else (e.message ?: "识别失败")
                        showBubble(msg, 4_000L)
                    },
                )
            }
        }
    }

    private fun hideIme() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(input.windowToken, 0)
        input.clearFocus()
    }

    // ---- 摸头 + 长按设置 ----

    @Suppress("ClickableViewAccessibility")
    private fun bindTouch(root: FrameLayout) {
        val gestures = GestureDetector(
            this,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onDown(e: MotionEvent): Boolean = true

                override fun onSingleTapUp(e: MotionEvent): Boolean {
                    val plan = motionPlan ?: return true
                    if (plan.tapGroups.isNotEmpty()) {
                        controller.playMotion(plan.tapGroups[random.nextInt(plan.tapGroups.size)])
                    }
                    if (input.hasFocus()) hideIme()
                    return true
                }

                override fun onLongPress(e: MotionEvent) {
                    startActivity(Intent(this@LiteMainActivity, SettingsActivity::class.java))
                }
            },
        )
        root.setOnTouchListener { v, event ->
            // 摆件态里第一下触摸只负责唤回聊天态（不摸头不跟视线）
            if (pendantMode) {
                if (event.actionMasked == MotionEvent.ACTION_DOWN) onUserActivity()
                return@setOnTouchListener true
            }
            onUserActivity()
            gestures.onTouchEvent(event)
            val nx = (event.x / v.width) * 2f - 1f
            val ny = (event.y / v.height) * 2f - 1f
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> controller.setFocus(nx, ny)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> controller.setFocus(0f, 0f)
            }
            true
        }
    }

    // ---- 系统 UI / 生命周期 ----

    private fun enterImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    /** 充电状态跟踪（sticky 广播）：只有充电中闲置才切摆件态。 */
    private val chargingReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: Intent) {
            val status = intent.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1)
            charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                status == android.os.BatteryManager.BATTERY_STATUS_FULL
            if (!charging && pendantMode) enterChatMode()
        }
    }

    override fun onPause() {
        super.onPause()
        controller.pauseIfVisible()
        mainHandler.removeCallbacks(pendantIdleRunnable)
        runCatching { unregisterReceiver(chargingReceiver) }
    }

    override fun onResume() {
        super.onResume()
        controller.resumeIfVisible()
        registerReceiver(chargingReceiver, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?.let { chargingReceiver.onReceive(this, it) }
        onUserActivity()
        // 设置页里切了角色/帧率 → 回来重载
        val avatar = currentAvatar
        if (avatar != null &&
            (avatar.id != AvatarRepo.currentAvatarId || loadedFps != AvatarRepo.targetFps)
        ) {
            ttsPlayer.stop()
            loadCurrentAvatar()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacks(pendantIdleRunnable)
        ttsPlayer.stop()
        controller.destroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
