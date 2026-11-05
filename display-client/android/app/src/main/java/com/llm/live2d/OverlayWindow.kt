package com.llm.live2d

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.llm.live2d.nativelive2d.NativeLive2DController

/**
 * 桌宠 overlay 窗：WindowManager 悬浮容器（TYPE_APPLICATION_OVERLAY）。
 *
 * 内容层（自底向上）：
 *  1. GL SurfaceView（低端机原生路径，由 [NativeLive2DScreensaverBridge] 在 index 0 垫入）
 *  2. 透明 WebView：跑 pet.html?avatar=<id>，只渲染屏保同款 Live2DScene（高端走 Pixi、低端走上面的 GL）
 *  3. 透明 touchCatcher：WebView 会吞触摸，故盖一层接管拖动/长按/点按（WebView 拿不到触摸）
 *  4. 关闭 ✕：最上层，可点击
 *
 * 复用屏保 [Live2DDreamService] 的 WebView+GL 装配（WebViewAssetLoader + 两个 JS 桥），
 * 桥的 window 参传 null（overlay 无 Dram Window，透明靠 webView.setBackgroundColor(TRANSPARENT)）。
 */
class OverlayWindow(
    private val context: Context,
    private val avatarId: String,
    private val petQuery: String,
    widthDp: Int,
    aspect: String,
    // 跨源注入 apiClient token（真实 RTC 用）：pet.localhost 与主 App localhost 不共享 localStorage，
    // 故不走 URL 参（petQuery 属于可被 WebView/诊断工具观察的导航数据），改在页面加载完后
    // 经 evaluateJavascript 调 window.__petAuth 注入，见 buildWebView() 的 onPageFinished。
    token: String = "",
    // 固定模式（U3 电台桌面「live2d 小浮窗（固定）」）：禁拖动，落点常驻初始位置。点按/长按/关闭仍生效。
    private val fixed: Boolean = false,
    // 固定模式的精确几何（原始像素，与 U3 主界面「live2d 小浮窗」贴纸格子的设计坐标 1:1 对齐；
    // U3 设计画布 480×640 = 该机真实物理分辨率，故 UI 传来的设计坐标可直接当屏幕像素用，无需换算 dp）。
    // 传 null 则回落原有拖动模式默认值（80,320 起始位置 + widthDp/aspect 算出的尺寸）。
    private val fixedXPx: Int? = null,
    private val fixedYPx: Int? = null,
    private val fixedWidthPx: Int? = null,
    private val fixedHeightPx: Int? = null,
    // ★触摸穿透（掌机底条用）：窗口整个设 FLAG_NOT_TOUCHABLE，所有触摸直达下层应用。
    // 动机（Ben 报告，2026-07-30）：底条 720×240 在原生层吃掉整条底边的触摸，模拟器
    // 画面底部的快捷按钮点不到；且点到角色会误触发旧桌宠的打电话流程。窗口收不到触摸
    // = 两个问题一起从物理上消失。军师问答要接「点角色提问」时，别翻回可触——
    // 改用 ViewTreeObserver.OnComputeInternalInsetsListener 的可触区域只给角色开洞。
    private val touchThrough: Boolean = false,
    // 掌机 Figma 底条：按钮/按住说话在 DOM 里，WebView 必须直接接触摸；
    // 普通桌宠仍由原生 touchCatcher 接管拖动/长按/点按。
    private val webTouchable: Boolean = false,
    // Aiboo 后台（阿里云）的设备 token —— 军师**语音**走那边（/ai/asr、/ai/tts）。
    // ★与上面的 token 是两个东西：那个是军师服务端的 device token。之前只有一条注入
    // 通道，两者互相覆盖过一次。同样不进 URL，走 evaluateJavascript 注入。
    aibooToken: String = "",
) {
    private val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val root = FrameLayout(context)
    private var webView: WebView? = null
    private var controller: NativeLive2DController? = null
    private var nativeLive2DBridge: NativeLive2DScreensaverBridge? = null
    private var sensorRegistered = false
    private var presented = false
    private var presentationId = 0L
    private var revealedElapsedMs = 0L
    private var interactionEnabled = true
    // M2 通话：通话中 JS 经 AibooPetOverlay.setCallActive(true) 隐藏它，放行触摸给 WebView（挂断/麦克风按钮
    // 在 DOM 里）；挂断后置回 VISIBLE 恢复拖动/长按/点按。见 addTouchCatcher()/buildWebView() 的桥。
    private var touchCatcher: View? = null
    private val authState = OverlayAuthState(token, aibooToken)

    // 陀螺仪原生桥：桌宠页跑 http://pet.localhost，WebView 传感器（即便安全上下文）在 overlay WebView 里
    // 不可靠/被门控，故直接用原生 SensorManager 读加速度，节流后经 evaluateJavascript 喂 window.__petAccel，
    // JS 侧复用 deviceTilt.ts 的 accelToTiltAngles/tiltToFocus 转成朝向。不依赖 WebView 传感器权限/安全上下文。
    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private var accelPushAt = 0L
    private val accelListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val now = System.currentTimeMillis()
            if (now - accelPushAt < 60) return // 节流 ~16fps，够跟随且省 evaluateJavascript 开销
            accelPushAt = now
            val x = e.values[0]; val y = e.values[1]; val z = e.values[2]
            webView?.evaluateJavascript("window.__petAccel&&window.__petAccel($x,$y,$z)", null)
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }

    private val lp = WindowManager.LayoutParams(
        0, 0,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        // touchThrough 的 FLAG_NOT_TOUCHABLE 在 init 里补（ctor 参数顺序限制，见下）
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = fixedXPx ?: 80
        y = fixedYPx ?: 320
    }

    /** 点按（预留给 M2 通话）、长按（开主 App）、关闭 回调，由 Service 注入。 */
    var onTap: (() -> Unit)? = null
    var onLongPress: (() -> Unit)? = null
    var onClose: (() -> Unit)? = null
    var onOpenSettings: (() -> Unit)? = null
    var onExitGame: (() -> Unit)? = null
    /** Live2D 首帧就绪回调（U3 固定浮窗用：主 App 等它而非 start() 调用本身来收 loading，
     * 见 pet/main.tsx 的 window.AibooOverlayReady.ready() 桥）。 */
    var onReady: (() -> Unit)? = null
    /** Fired only by NativeLive2DController after its actual onHostResume call completes. */
    var onNativeHostResumed: ((Long) -> Unit)? = null
    /** Captures the bridge-entry clock with the numeric ID; the service filters stale traces. */
    var onAudioStarted: ((Long, Long) -> Unit)? = null

    init {
        if (touchThrough) {
            lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        buildWebView()
        // 穿透窗口收不到任何触摸，touchCatcher/点按/长按全是死代码，不装。
        if (!touchThrough && !webTouchable) addTouchCatcher()
        // 固定浮窗（U3 主界面）现在由页面进入/离开自动起停，不需要手动关闭 ✕。
        if (!fixed) addCloseButton()
        applyDimensions(widthDp, aspect)
        if (fixedWidthPx != null && fixedHeightPx != null) {
            lp.width = fixedWidthPx
            lp.height = fixedHeightPx
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView() {
        WebView.setWebContentsDebuggingEnabled(true)

        // 域名=pet.localhost + http：一箭双雕。
        // ① setHttpAllowed(true)+http 源：后端角色背景图是 http://your-aiboo-host:3456/...（cleartext），
        //    页面若 https 加载 http 图=mixed content 被拦（MIXED_CONTENT_ALWAYS_ALLOW 对 appassets 安全源不生效）。
        //    页面同为 http → 非混合内容 → 放行。
        // ② setDomain("pet.localhost")：DeviceOrientation/加速度计要求**安全上下文**，http://appassets 不是→传感器被禁
        //    →陀螺仪失效。Chromium 把 *.localhost 判为安全上下文（potentially trustworthy），故 http://pet.localhost
        //    既是 http（①成立）又是安全上下文（传感器可用）。用子域 pet.localhost 而非 localhost 避免与主 App
        //    （http://localhost）同源共享 localStorage/storage 事件串扰。
        val assetLoader = WebViewAssetLoader.Builder()
            .setHttpAllowed(true)
            .setDomain("pet.localhost")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()

        val wv = WebView(context)
        wv.setBackgroundColor(Color.TRANSPARENT)
        wv.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            // 页面加载完成后再注入 token：此时 pet/main.tsx 的 useEffect 已跑过、
            // window.__petAuth 保证已挂载。JSONObject.quote 生成带引号且已转义的 JS 字符串字面量，
            // 避免 token 里出现 ' " \ 等字符时破坏拼接的 JS（JWT 正常不含这些字符，但做防御性处理）。
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                injectLatestAuth(view)
                pushPresentationState(view)
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean = true

            // M2 通话：真实火山 RTC 用 getUserMedia 采集麦克风(+视频通话摄像头)，WebView 默认拒绝，
            // 须显式 grant 请求到的 resources。这只是 WebView 层放行——运行时 RECORD_AUDIO 权限
            // 仍须已被主 App/系统设置授予（本 Service 无 Activity 上下文，无法在此发起运行时权限
            // 请求弹窗），否则底层采集依旧会失败，通话仍连得上但对方听不到你。
            override fun onPermissionRequest(request: PermissionRequest) {
                val wanted = request.resources.filter {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }
                if (wanted.isEmpty()) {
                    request.deny()
                    return
                }
                root.post { request.grant(wanted.toTypedArray()) }
            }
        }
        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // 低端机原生 Live2D：与屏保/主 App 同一套 Controller（GL 垫底 + Cubism）。
        val ctl = NativeLive2DController(context)
        wv.addJavascriptInterface(ScreensaverBridge(context.applicationContext), "AibooNative")
        val nativeBridge = NativeLive2DScreensaverBridge(
            // transparentOverlay=true：悬浮窗原生 GL 透明合成（切 SDK 后角色悬浮，露出下层桌面/主界面）。
            ctl,
            root,
            wv,
            null,
            true,
        ) { id -> root.post { onNativeHostResumed?.invoke(id) } }
        nativeLive2DBridge = nativeBridge
        wv.addJavascriptInterface(
            nativeBridge,
            "AibooNativeLive2D",
        )
        // M2 通话态放行：pet/main.tsx 的 callMode useEffect 调 setCallActive(true/false)。
        // JS 接口回调在 binder 线程，触摸/可见性必须回 UI 线程（root.post）。
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun setCallActive(active: Boolean) {
                root.post { touchCatcher?.visibility = if (active) View.GONE else View.VISIBLE }
            }
        }, "AibooPetOverlay")
        // Live2D 首帧就绪信号：pet/main.tsx 的 Live2DScene onReady 回调里调用。
        // JS 接口回调在 binder 线程，onReady 里可能触发跨进程/主线程操作，回 UI 线程更安全。
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun ready() {
                root.post { onReady?.invoke() }
            }
        }, "AibooOverlayReady")
        // 军师截屏桥。★JavascriptInterface 是同步的而截屏是异步的 —— 故用
        // 「JS 传 reqId → 原生回调 window.__strategistShot(reqId, base64, errCode)」
        // 这种请求/应答形状，与 __petFraming 那类单向推送不同。
        // 能力实现与主 App 的 StrategistPlugin 共用同一个 ScreenCapture，只有一份。
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun capture(reqId: String, cropBottomPx: Int, maxBytes: Int) {
                ScreenCapture.capture(AibooKeyService.instance, cropBottomPx, maxBytes) { r ->
                    val (b64, err) = when (r) {
                        is ScreenCapture.Result.Ok -> r.jpegBase64 to ""
                        is ScreenCapture.Result.Err -> "" to r.code
                    }
                    // 回主线程再碰 WebView（ScreenCapture 的 cb 已在主线程，post 是防御性的）。
                    wv.post {
                        wv.evaluateJavascript(
                            "window.__strategistShot&&window.__strategistShot(" +
                                "${org.json.JSONObject.quote(reqId)}," +
                                "${org.json.JSONObject.quote(b64)}," +
                                "${org.json.JSONObject.quote(err)})",
                            null,
                        )
                    }
                }
            }
        }, "AibooStrategist")
        // 军师语音播报：走原生 MediaPlayer 而不是 WebView 的 <audio>。
        // ★<audio> 永远是 STREAM_MUSIC，和游戏同一条媒体音量，玩家没法分开调（Ben 实报）；
        // JS 侧没有 API 能选音频流，只能挪到原生。流的选择与 ducking 见 StrategistAudio。
        // 请求/应答形状同截屏桥：JS 传 reqId，播完回调 window.__strategistAudioDone(reqId)。
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun play(reqId: String, base64: String) {
                // JavascriptInterface 在 binder 线程，MediaPlayer 要在有 Looper 的线程建。
                wv.post {
                    StrategistAudio.play(context, base64) {
                        wv.post {
                            wv.evaluateJavascript(
                                "window.__strategistAudioDone&&window.__strategistAudioDone(" +
                                    "${org.json.JSONObject.quote(reqId)})",
                                null,
                            )
                        }
                    }
                }
            }

            @android.webkit.JavascriptInterface
            fun stop() {
                wv.post { StrategistAudio.stop() }
            }

            @android.webkit.JavascriptInterface
            fun beginUtterance() {
                wv.post { StrategistAudio.beginUtterance(context) }
            }

            @android.webkit.JavascriptInterface
            fun endUtterance() {
                wv.post { StrategistAudio.endUtterance(context) }
            }
        }, "AibooStrategistAudio")
        // 玩家存档桥：读 RetroArch 的 .srm，让军师知道「他现在打到哪」。
        // 请求/应答形状与截屏桥一致（JS 传 reqId，原生回调 window.__strategistSave）：
        // 存档 base64 约 176KB，和截屏 JPEG 一个量级，走已经验证过的同一条路。
        // 候选路径由 JS 侧算好传进来（src/lib/strategist/saveFile.ts），原生只做磁盘查找。
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun read(reqId: String, candidatesJson: String, sinceMtimeMs: String) {
                // JavascriptInterface 在 binder 线程 —— 不是主线程，磁盘 IO 放这里没问题。
                val json = SaveFileReader.read(candidatesJson, sinceMtimeMs.toLongOrNull() ?: 0L)
                // ★碰 WebView 必须回主线程（跨线程调 evaluateJavascript 必崩，已经栽过）。
                wv.post {
                    wv.evaluateJavascript(
                        "window.__strategistSave&&window.__strategistSave(" +
                            "${org.json.JSONObject.quote(reqId)}," +
                            "${org.json.JSONObject.quote(json)})",
                        null,
                    )
                }
            }
        }, "AibooStrategistSave")
        // 面板可滑开关：JS 在「有答案挂着」时开、收起时关。见 setPanelTouchable 注释。
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun setPanelTouchable(touchable: Boolean) {
                root.post { this@OverlayWindow.setPanelTouchable(touchable) }
            }
        }, "AibooStrategistPanel")
        wv.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun audioStarted(presentationId: Long) {
                val eventAtMs = SystemClock.elapsedRealtime()
                // JavascriptInterface runs off-main. Preserve this capture time while the main
                // looper validates the presentation and records the trace asynchronously.
                root.post { onAudioStarted?.invoke(presentationId, eventAtMs) }
            }

            @android.webkit.JavascriptInterface
            fun openSettings() {
                root.post { onOpenSettings?.invoke() }
            }

            @android.webkit.JavascriptInterface
            fun exitGame() {
                root.post { onExitGame?.invoke() }
            }
        }, "AibooHandheldStrip")

        root.addView(
            wv,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        val extra = if (petQuery.isNotEmpty()) "&$petQuery" else ""
        wv.loadUrl("http://pet.localhost/assets/public/pet.html?avatar=$avatarId$extra")

        webView = wv
        controller = ctl
    }

    /** Refresh credentials on a retained warm WebView, including empty values that clear old auth. */
    fun updateAuth(token: String, aibooToken: String) {
        authState.update(token, aibooToken)
        val inject = { webView?.let(::injectLatestAuth); Unit }
        if (Looper.myLooper() == Looper.getMainLooper()) inject() else root.post(inject)
    }

    private fun injectLatestAuth(view: WebView) {
        val auth = authState.current()
        view.evaluateJavascript(
            "window.__petAuth&&window.__petAuth(${org.json.JSONObject.quote(auth.token)})",
            null,
        )
        view.evaluateJavascript(
            "window.__aibooAuth&&window.__aibooAuth(${org.json.JSONObject.quote(auth.aibooToken)})",
            null,
        )
    }

    /** 透明触摸接管层：盖在 WebView 之上，拖动/长按/点按都在这里，WebView 拿不到触摸（M1 页面无交互）。 */
    @SuppressLint("ClickableViewAccessibility")
    private fun addTouchCatcher() {
        val catcher = View(context)
        touchCatcher = catcher
        root.addView(
            catcher,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        val slop = ViewConfiguration.get(context).scaledTouchSlop
        val longMs = ViewConfiguration.getLongPressTimeout().toLong()
        val h = Handler(context.mainLooper)
        var downX = 0f; var downY = 0f; var startPx = 0; var startPy = 0
        var downT = 0L; var moved = false; var longFired = false
        // 惯性晄晃：把每帧拖拽增量喂给桌宠页 window.__petDrag，JS 侧做弹簧回弹驱动角色摆动。
        var lastMoveX = 0f; var lastMoveY = 0f
        val longR = Runnable { if (!moved) { longFired = true; onLongPress?.invoke() } }

        catcher.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startPx = lp.x; startPy = lp.y
                    lastMoveX = e.rawX; lastMoveY = e.rawY
                    downT = e.eventTime; moved = false; longFired = false
                    h.postDelayed(longR, longMs)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!moved && kotlin.math.hypot(dx, dy) > slop) { moved = true; h.removeCallbacks(longR) }
                    // fixed 模式不挪窗、不喂晃动增量（U3 固定浮窗）；moved 仍置位以保留「拖动=非点按」语义。
                    if (moved && !fixed) {
                        lp.x = startPx + dx.toInt(); lp.y = startPy + dy.toInt(); update()
                        val ddx = e.rawX - lastMoveX; val ddy = e.rawY - lastMoveY
                        lastMoveX = e.rawX; lastMoveY = e.rawY
                        webView?.evaluateJavascript("window.__petDrag&&window.__petDrag($ddx,$ddy)", null)
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    h.removeCallbacks(longR)
                    if (!moved && !longFired && e.eventTime - downT < longMs) {
                        onTap?.invoke()
                        // M2 通话触发桥：单击 → 桌宠页切到通话占位态（window.__petStartCall，main.tsx 挂载）。
                        webView?.evaluateJavascript("window.__petStartCall&&window.__petStartCall('voice')", null)
                    }
                    true
                }
                else -> false
            }
        }
    }

    /** 右上角关闭 ✕：可点击子 view，位于 touchCatcher 之上，不被拖动吞。 */
    private fun addCloseButton() {
        val d = context.resources.displayMetrics.density
        val sz = (24 * d).toInt()
        val m = (6 * d).toInt()
        val btn = TextView(context).apply {
            text = "✕"
            setTextColor(Color.WHITE)
            textSize = 12f
            gravity = Gravity.CENTER
            // 圆形背景：避免方形叠在圆角卡片的圆角上显出直角。
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(Color.argb(120, 0, 0, 0))
            }
            isClickable = true
            setOnClickListener { onClose?.invoke() }
        }
        val clp = FrameLayout.LayoutParams(sz, sz, Gravity.TOP or Gravity.END)
        clp.topMargin = m
        clp.marginEnd = m
        root.addView(btn, clp)
    }

    /**
     * 底条取景热更新：把新的取景目标推给 pet 页，只重算构图不重载模型。
     * ★走 evaluateJavascript 而不是重启服务：重启 = 重载模型 = 约 2.5 秒，
     * 桌面设置页的实时预览就没了。通道与 __petAccel/__petDrag/__petStartCall 同形状。
     */
    fun applyFraming(headScreenY: Double, faceScreenFrac: Double) {
        val wv = webView ?: return
        // ★必须 post 回主线程：本方法由 OverlayPlugin 在 Capacitor 的插件线程上调用，
        // 而 WebView 的所有方法只能在创建它的线程（主线程）调 —— 直接调必崩：
        // "A WebView method was called on thread 'CapacitorPlugins'"（真机实测）。
        // 旁边那几条桥（__petAccel/__petDrag/__petStartCall）都本来就在主线程上，没这问题。
        wv.post {
            wv.evaluateJavascript(
                "window.__petFraming&&window.__petFraming($headScreenY,$faceScreenFrac)",
                null,
            )
        }
    }

    /**
     * 把角色触摸事件推给底条页（军师问答入口）。kind ∈ tap / holdStart / holdEnd。
     * ★必须 post 回主线程——与 applyFraming 同理，WebView 方法只能在创建它的线程调
     * （真机实测过 "A WebView method was called on thread 'CapacitorPlugins'" 崩溃）。
     * 本方法的调用方是 StrategistTapWindow 的触摸回调（本来就在主线程），post 是防御性的。
     */
    fun pushTap(kind: String) {
        val wv = webView ?: return
        wv.post {
            wv.evaluateJavascript(
                "window.__strategistTap&&window.__strategistTap(${org.json.JSONObject.quote(kind)})",
                null,
            )
        }
    }

    /**
     * 底条主窗的触摸穿透开关（军师面板要能上下滑答案）。
     *
     * ★底条平时必须 FLAG_NOT_TOUCHABLE：整条 720×240 一旦可触就吃掉模拟器画面底部的
     * 快捷按钮（Ben 实报）。但答案可能很长（一屏放不下），用户要能滑着看——手指碰不到
     * 面板就滑不了。
     * 解法是**按状态动态切**：只有「答案正挂在屏幕上」那段时间可触，那时候用户本来
     * 就在看答案而不是在玩；问下一个 / 收起答案就立刻恢复穿透。
     * 角色那个 240×240 的 tap 子窗是独立窗口且在上层，点/按住全程不受影响。
     */
    fun setPanelTouchable(touchable: Boolean) {
        if (!touchThrough) return // 非底条（普通桌宠浮窗）整窗本来就可触，不掺和
        if (!interactionEnabled) {
            lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            root.post { update() }
            return
        }
        val want = if (touchable) {
            lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        } else {
            lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        if (want == lp.flags) return
        lp.flags = want
        // WebView 的方法只能在主线程调；updateViewLayout 同理走 UI 线程更稳。
        root.post { update() }
    }

    /** 尺寸/比例（dp→px）：宽=widthDp，高由 aspect(宽:高) 推出。实时可改（updateViewLayout）。 */
    fun applyDimensions(widthDp: Int, aspect: String) {
        val d = context.resources.displayMetrics.density
        val parts = aspect.split(":")
        val aw = parts.getOrNull(0)?.toFloatOrNull() ?: 3f
        val ah = parts.getOrNull(1)?.toFloatOrNull() ?: 4f
        lp.width = (widthDp * d).toInt()
        lp.height = (widthDp * (ah / aw) * d).toInt()
        update()
    }

    fun update() { if (root.isAttachedToWindow) wm.updateViewLayout(root, lp) }

    fun addToWindow() {
        if (!root.isAttachedToWindow) wm.addView(root, lp)
        presented = true
        setInteractionEnabled(true)
        pushPresentationState()
        registerSensor()
    }

    /** 普通桌宠在 App 前台时只隐藏视图，保留 WebView/GL 资源供返回桌面热恢复。 */
    fun setVisible(visible: Boolean) {
        val target = if (visible) View.VISIBLE else View.GONE
        if (root.visibility == target) return
        root.visibility = target
        if (visible) registerSensor() else unregisterSensor()
    }

    /** Attach the real strip window offscreen while WebView/GL produce their initial composite. */
    fun warmHidden(id: Long) {
        presentationId = id
        revealedElapsedMs = 0L
        nativeLive2DBridge?.setLifecycleTraceId(id)
        presented = false
        setInteractionEnabled(false)
        moveOffscreen()
        if (!root.isAttachedToWindow) wm.addView(root, lp)
        webView?.onResume()
        pushPresentationState()
    }

    /** Show only the accepted DOM loading shell; model interaction remains disabled. */
    fun showLoading(id: Long) {
        presentationId = id
        revealedElapsedMs = 0L
        nativeLive2DBridge?.setLifecycleTraceId(id)
        presented = false
        setInteractionEnabled(false)
        webView?.onResume()
        moveOnscreen()
        if (!root.isAttachedToWindow) wm.addView(root, lp)
        pushPresentationState()
    }

    /** Resume a parked renderer offscreen and reveal only after a strictly later composite frame. */
    fun resumeForPresentation(
        id: Long,
        onFrame: () -> Unit,
    ) {
        presentationId = id
        revealedElapsedMs = 0L
        nativeLive2DBridge?.setLifecycleTraceId(id)
        presented = false
        setInteractionEnabled(false)
        moveOffscreen()
        webView?.onResume()
        pushPresentationState()
        val activeController = controller?.takeIf { it.isAttached }
        when (StripFrameWaitPolicy.forRenderer(activeController != null)) {
            StripFrameWaitSource.NATIVE_COMPOSITE -> activeController!!.showAfterFrame(
                id,
                { resumedId -> root.post { onNativeHostResumed?.invoke(resumedId) } },
            ) { root.post { onFrame() } }
            StripFrameWaitSource.WEBVIEW_VISUAL_STATE -> {
                val activeWebView = webView ?: return
                activeWebView.postVisualStateCallback(
                    id,
                    object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) {
                            root.post { onFrame() }
                        }
                    },
                )
            }
        }
    }

    fun reveal(id: Long, elapsedMs: Long) {
        if (id != presentationId) return
        revealedElapsedMs = elapsedMs.coerceAtLeast(0L)
        presented = true
        moveOnscreen()
        setInteractionEnabled(true)
        registerSensor()
        pushPresentationState()
    }

    /** Pause renderer/WebView and retain every expensive resource while the window stays attached. */
    fun parkOffscreen(onPaused: (() -> Unit)? = null) {
        presented = false
        revealedElapsedMs = 0L
        unregisterSensor()
        StrategistAudio.stop()
        setInteractionEnabled(false)
        moveOffscreen()
        pushPresentationState()
        controller?.hideAfterPause {
            root.post {
                webView?.onPause()
                onPaused?.invoke()
            }
        } ?: root.post {
            webView?.onPause()
            onPaused?.invoke()
        }
    }

    fun removeFromWindow() {
        unregisterSensor()
        if (root.isAttachedToWindow) wm.removeView(root)
        destroy()
    }

    /** 清理 GL 控制器 + WebView（避免泄漏/GL 上下文残留）。 */
    fun destroy() {
        unregisterSensor()
        controller?.destroy()
        controller = null
        nativeLive2DBridge = null
        webView?.let { wv ->
            try {
                wv.loadUrl("about:blank")
                wv.removeJavascriptInterface("AibooNative")
                wv.removeJavascriptInterface("AibooNativeLive2D")
                wv.removeJavascriptInterface("AibooPetOverlay")
                wv.removeJavascriptInterface("AibooStrategist")
                wv.removeJavascriptInterface("AibooStrategistAudio")
                wv.removeJavascriptInterface("AibooStrategistSave")
                wv.removeJavascriptInterface("AibooStrategistPanel")
                wv.removeJavascriptInterface("AibooHandheldStrip")
                StrategistAudio.stop()
                wv.destroy()
            } catch (_: Throwable) {
                // ignore
            }
        }
        webView = null
        touchCatcher = null
    }

    private fun registerSensor() {
        if (sensorRegistered) return
        sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensorManager.registerListener(accelListener, it, SensorManager.SENSOR_DELAY_GAME)
            sensorRegistered = true
        }
    }

    private fun unregisterSensor() {
        if (!sensorRegistered) return
        sensorManager?.unregisterListener(accelListener)
        sensorRegistered = false
    }

    private fun moveOffscreen() {
        val displayWidth = context.resources.displayMetrics.widthPixels
        lp.x = -kotlin.math.max(displayWidth, lp.width) - 1
        update()
    }

    private fun moveOnscreen() {
        lp.x = fixedXPx ?: 80
        lp.y = fixedYPx ?: 320
        update()
    }

    private fun setInteractionEnabled(enabled: Boolean) {
        interactionEnabled = enabled
        lp.flags = if (!enabled || touchThrough) {
            lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        } else {
            lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        }
        update()
    }

    private fun pushPresentationState(target: WebView? = webView) {
        target?.evaluateJavascript(
            "window.__petPresentation&&window.__petPresentation(" +
                "$presented,$presentationId,$revealedElapsedMs)",
            null,
        )
    }
}
