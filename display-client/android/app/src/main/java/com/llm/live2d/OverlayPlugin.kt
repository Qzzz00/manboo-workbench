package com.llm.live2d

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.util.concurrent.atomic.AtomicBoolean
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 桌宠浮窗控制（JS 桥）：SAW 授权查询/请求 + 拉起/停止前台服务 + 尺寸切换。
 * 渲染/拖动/生命周期在 Live2DOverlayService + OverlayWindow。
 */
@CapacitorPlugin(name = "Overlay")
class OverlayPlugin : Plugin() {

    override fun load() {
        // Live2D 首帧就绪 → JS 'ready' 事件（U3 固定浮窗等它收 loading，而非 start() 调用本身，
        // 后者只代表 startForegroundService 已派发，WebView 还没画出角色）。
        Live2DOverlayService.readyListener = {
            Handler(Looper.getMainLooper()).post { notifyListeners("ready", JSObject()) }
        }
    }

    override fun handleOnDestroy() {
        Live2DOverlayService.readyListener = null
    }

    @PluginMethod
    fun hasOverlayPermission(call: PluginCall) {
        val ok = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)
        call.resolve(JSObject().put("granted", ok))
    }

    @PluginMethod
    fun requestOverlayPermission(call: PluginCall) {
        val i = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
        call.resolve()
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val intent = buildOverlayIntent(call) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            call.reject("overlay permission not granted"); return
        }
        val persistentStrip = OverlayStartPolicy.modeFor(
            intent.getStringExtra("petQuery") ?: "",
        ) == OverlayStartMode.PERSISTENT_STRIP
        val behavior = OverlayLaunchPolicy.forRequest(
            OverlayLaunchRequest.START,
            fixed = intent.getBooleanExtra("fixed", false),
            persistentStrip = persistentStrip,
        )
        // Legacy touch-through strips used this start-side persistence before the Figma strip
        // existed. Keep it without granting them the new persistent renderer lifecycle.
        if (behavior.persistStripParams || intent.getBooleanExtra("touchThrough", false)) {
            StripIntentStore.save(context, intent)
        }
        if (behavior.startService) context.startForegroundService(intent)
        // 桌宠浮窗的语义就是「主 App 不在前台也能看到角色」，起浮窗后就该让位。
        // 不让位的后果不只是两个角色同框难看：主 App 与浮窗是两个各自满帧的原生 GL SurfaceView，
        // 同屏争抢 GPU 会让帧间隔抖动，而 Cubism 物理按 dt 演算，dt 一抖就失控——现象就是角色疯狂抽搐。
        // U3 固定浮窗(fixed=true)是桌面启动器场景，主界面必须留在前台，故不收。
        if (behavior.moveTaskToBack) {
            Handler(Looper.getMainLooper()).post { activity?.moveTaskToBack(true) }
        }
        call.resolve()
    }

    /** Hidden bottom-strip prewarm. It persists identical params and never backgrounds MainActivity. */
    @PluginMethod
    fun prewarm(call: PluginCall) {
        val intent = buildOverlayIntent(call) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            call.reject("overlay permission not granted")
            return
        }
        if (OverlayStartPolicy.modeFor(intent.getStringExtra("petQuery") ?: "") !=
            OverlayStartMode.PERSISTENT_STRIP
        ) {
            call.resolve()
            return
        }
        val behavior = OverlayLaunchPolicy.forRequest(
            OverlayLaunchRequest.PREWARM,
            fixed = intent.getBooleanExtra("fixed", false),
            persistentStrip = true,
        )
        intent.putExtra(Live2DOverlayService.EXTRA_WARM_ONLY, true)
        if (behavior.persistStripParams) StripIntentStore.save(context, intent)
        if (behavior.startService) context.startForegroundService(intent)
        call.resolve()
    }

    /**
     * 只持久化底条参数、不启动（AibooKeyService 的 F10 切换回放用）。
     * 桌面启动与设置变更时调用——底条改成按键呼出后，JS 不再自动 start，
     * 不落这份参数的话 F10 将永远无的放矢。参数面与 start 一致。
     */
    @PluginMethod
    fun saveStripParams(call: PluginCall) {
        val intent = buildOverlayIntent(call) ?: return
        val behavior = OverlayLaunchPolicy.forRequest(
            OverlayLaunchRequest.SAVE_ONLY,
            fixed = intent.getBooleanExtra("fixed", false),
        )
        if (behavior.persistStripParams) StripIntentStore.save(context, intent)
        call.resolve()
    }

    private fun buildOverlayIntent(call: PluginCall): Intent? {
        val avatarId = call.getString("avatarId") ?: run {
            call.reject("avatarId required")
            return null
        }
        return Intent(context, Live2DOverlayService::class.java)
            .putExtra("avatarId", avatarId)
            .putExtra("widthDp", call.getInt("widthDp") ?: 260)
            .putExtra("aspect", call.getString("aspect") ?: "3:4")
            .putExtra("petQuery", call.getString("petQuery") ?: "")
            // Tokens stay in Intent extras only; never add them to query/signature/log output.
            .putExtra("token", call.getString("token") ?: "")
            .putExtra("aibooToken", call.getString("aibooToken") ?: "")
            .putExtra("fixed", call.getBoolean("fixed", false) ?: false)
            .putExtra("touchThrough", call.getBoolean("touchThrough", false) ?: false)
            .putExtra("webTouchable", call.getBoolean("webTouchable", false) ?: false)
            .also { intent ->
                call.getInt("xPx")?.let { intent.putExtra("xPx", it) }
                call.getInt("yPx")?.let { intent.putExtra("yPx", it) }
                call.getInt("widthPx")?.let { intent.putExtra("widthPx", it) }
                call.getInt("heightPx")?.let { intent.putExtra("heightPx", it) }
            }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        // resolve 的语义必须是「浮窗 GL 已离场」，不是「已向 Service 发 stop intent」。
        // 主页会以它为门槛挂自己的 renderer；过早 resolve 会复现双 Cubism renderer 的物理抽动。
        val resolved = AtomicBoolean(false)
        fun resolveOnce() {
            if (resolved.compareAndSet(false, true)) {
                Handler(Looper.getMainLooper()).post { call.resolve() }
            }
        }
        if (!Live2DOverlayService.isRunning && Live2DOverlayService.instance == null) {
            context.stopService(Intent(context, Live2DOverlayService::class.java))
            resolveOnce()
            return
        }
        Live2DOverlayService.whenStopped(::resolveOnce)
        val service = Live2DOverlayService.instance
        if (service != null) {
            service.destroyOverlay()
        } else if (!context.stopService(Intent(context, Live2DOverlayService::class.java))) {
            // 系统已认定服务不存在时，没有 onDestroy 可等；兜底放行，且 resolveOnce 防重复。
            resolveOnce()
        }
    }

    @PluginMethod
    fun isRunning(call: PluginCall) {
        call.resolve(JSObject().put("running", Live2DOverlayService.isRunning))
    }

    @PluginMethod
    fun setDimensions(call: PluginCall) {
        Live2DOverlayService.instance?.applyDimensions(call.getInt("widthDp") ?: 260, call.getString("aspect") ?: "3:4")
        call.resolve()
    }

    /**
     * 底条取景热更新（桌面设置页拖滑块的实时预览）。
     * ★绝不能改成重启服务：那会重载模型（真机约 2.5 秒），实时性就没了。
     * 服务没在跑时静默 no-op——设置页没起预览（比如没给悬浮窗权限）时滑块照样能拖能存。
     */
    @PluginMethod
    fun updateFraming(call: PluginCall) {
        val hy = call.getDouble("headScreenY")
        val ff = call.getDouble("faceScreenFrac")
        if (hy == null || ff == null) { call.reject("headScreenY/faceScreenFrac required"); return }
        Live2DOverlayService.instance?.applyFraming(hy, ff)
        call.resolve()
    }
}
