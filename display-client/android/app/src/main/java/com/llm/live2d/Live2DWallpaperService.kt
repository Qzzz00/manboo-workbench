package com.llm.live2d

import android.service.wallpaper.WallpaperService
import android.util.Log
import android.view.SurfaceHolder
import com.llm.live2d.nativelive2d.NativeLive2DController
import com.llm.live2d.nativelive2d.WallpaperGLHost
import org.json.JSONObject

/**
 * Live2D 动态壁纸。
 *
 * 为什么是壁纸而不是屏保：屏保（[Live2DDreamService]）**必须插电**——`PowerManagerService`
 * 的 `canDreamLocked()` 读 `config_dreamsEnabledOnBattery`，那是编译进 framework-res 的 bool，
 * adb 改不了（RG 与 Pixel 实测皆为 false）。动态壁纸不受这条约束，且在**锁屏也持续渲染**
 * （RG 实测：伪拔电状态下锁屏壁纸每 3s 仍有 29% 像素变化）。
 *
 * 锁屏可见的前提是系统没有独立的锁屏壁纸——用户在壁纸选择器里选「主屏幕和锁定屏幕」即可清空。
 *
 * 架构要点：`WallpaperService.Engine` 只给 SurfaceHolder、没有 View 树，因此放不了 WebView
 * （屏保那套 screensaver.html + PixiJS 完全不可用），也放不了 GLSurfaceView。EGL 与渲染线程
 * 由 [WallpaperGLHost] 自管，渲染逻辑仍复用与主 App / 屏保 / 浮窗同一个 NativeLive2DRenderer。
 */
class Live2DWallpaperService : WallpaperService() {

    /**
     * ★同进程只能有一个 Live2D 渲染实例。
     *
     * `CubismFramework` 与 `CubismShaderAndroid` 都是全局单例，而系统会同时开**预览 Engine**
     * 与**实际壁纸 Engine**（实测 logcat 里两个 WIN DEATH 窗口）。两个 EGL 上下文抢同一份
     * shader 单例，后者在 `onSurfaceCreated` 调 `deleteInstance()` 时直接
     * `FATAL EXCEPTION: generateShaders` 崩掉整个壁纸进程。
     *
     * 策略：后创建的 Engine 接管，旧的立即交出渲染资源。用实例字段而非 static——
     * 同进程内所有 Engine 都由这一个 Service 实例创建，不必冒静态持有的泄漏风险。
     */
    private var activeEngine: Live2DEngine? = null

    override fun onCreateEngine(): Engine = Live2DEngine()

    private inner class Live2DEngine : Engine() {

        private var controller: NativeLive2DController? = null
        private var glHost: WallpaperGLHost? = null
        private var modelRequested = false

        /**
         * 系统告知的壁纸可见性。单独记一份的原因是时序：`showModel` 内部会把 host 置为可见，
         * 若它在 `onVisibilityChanged(false)` 之后才完成，就会在壁纸不可见时把渲染循环拉起来。
         * 故模型就绪后要用这份状态再纠正一次。
         */
        private var engineVisible = false

        // surface 现状。渲染权可能在 surface 就位之后才拿到（预览关闭后真实 Engine 才重新接管），
        // 那时要用这份记录把 surface 重新喂给新建的 GL host，否则它永远等不到回调。
        private var surfaceAlive = false
        private var surfaceW = 0
        private var surfaceH = 0

        override fun onCreate(surfaceHolder: SurfaceHolder) {
            super.onCreate(surfaceHolder)
            setTouchEventsEnabled(false) // 本期不做交互：桌面触摸被 launcher 抢、锁屏被 keyguard 吃
            // 渲染权不在这里抢——见 acquireRendering()
        }

        /**
         * 取得渲染权（幂等）。
         *
         * ★时机必须是「变为可见」而不是「Engine 创建」：预览 Engine 是在真实壁纸 Engine 之后
         * 创建的，若在 onCreate 抢占，就会把正在服役的真实 Engine 的 controller destroy 掉；
         * 等预览关闭、真实 Engine 重新可见时它已无 controller，applyVisibility() 第一行就
         * `?: return`，从此永久静止（实测：锁屏画面停在最后一帧、进程 CPU 0%）。
         */
        private fun acquireRendering() {
            if (controller != null) return

            activeEngine?.takeIf { it !== this }?.releaseRendering()
            activeEngine = this

            val c = NativeLive2DController(this@Live2DWallpaperService)
            if (!c.isCoreAvailable) {
                Log.e(TAG, "cubism core unavailable on this device; wallpaper will stay blank")
                return
            }
            controller = c
            glHost = c.attachToSurfaceHolder()
            Log.i(TAG, "acquired rendering (preview=$isPreview, surfaceAlive=$surfaceAlive)")

            // surface 早已就位时要补喂一次，否则新 host 收不到 create/changed 回调
            if (surfaceAlive) {
                glHost?.onEngineSurfaceCreated(surfaceHolder)
                if (surfaceW > 0 && surfaceH > 0) {
                    glHost?.onEngineSurfaceChanged(surfaceW, surfaceH)
                    modelRequested = true
                    loadModel()
                }
            }
        }

        /** 交出全部渲染资源（卸模型 + 销毁 EGL + 退渲染线程），让另一个 Engine 能安全接管。 */
        fun releaseRendering() {
            if (controller == null) return
            Log.i(TAG, "released rendering (preview=$isPreview)")
            controller?.destroy()
            controller = null
            glHost = null
            modelRequested = false
        }

        override fun onSurfaceCreated(holder: SurfaceHolder) {
            super.onSurfaceCreated(holder)
            surfaceAlive = true
            Log.i(TAG, "engine surfaceCreated (preview=$isPreview)")
            glHost?.onEngineSurfaceCreated(holder)
        }

        override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
            super.onSurfaceChanged(holder, format, width, height)
            surfaceAlive = true
            surfaceW = width
            surfaceH = height
            Log.i(TAG, "engine surfaceChanged ${width}x$height visible=$engineVisible")
            glHost?.onEngineSurfaceChanged(width, height)

            // 模型只加载一次：surface 尺寸变化（转屏）不该重新加载，renderer 内部会自行重建掩模缓冲。
            if (controller != null && !modelRequested && width > 0 && height > 0) {
                modelRequested = true
                loadModel()
            }
        }

        /**
         * ★功耗闸门。壁纸在用户打开任何 app 时都不可见，此时照跑纯属白烧电；
         * 可见性为 true 的场景恰好只有桌面与锁屏——正是目标场景。
         */
        override fun onVisibilityChanged(visible: Boolean) {
            super.onVisibilityChanged(visible)
            Log.i(TAG, "engine visibility=$visible (preview=$isPreview)")
            engineVisible = visible
            // 变可见时（重新）取得渲染权——可能上一轮被预览 Engine 抢走过
            if (visible) acquireRendering()
            applyVisibility()
        }

        override fun onSurfaceDestroyed(holder: SurfaceHolder) {
            Log.i(TAG, "engine surfaceDestroyed")
            surfaceAlive = false
            glHost?.onEngineSurfaceDestroyed()
            super.onSurfaceDestroyed(holder)
        }

        override fun onDestroy() {
            Log.i(TAG, "engine destroy")
            releaseRendering() // 内部会卸模型并销毁 EGL、退出渲染线程
            if (activeEngine === this) activeEngine = null
            super.onDestroy()
        }

        private fun applyVisibility() {
            val c = controller ?: return
            if (engineVisible) c.resumeIfVisible() else c.pauseIfVisible()
        }

        private fun loadModel() {
            val c = controller ?: return
            val ctx = this@Live2DWallpaperService

            val entry = WallpaperAvatars.resolve(ctx)
            if (entry == null) {
                Log.e(TAG, "no usable avatar entry; wallpaper stays blank")
                return
            }

            val opts = JSONObject().apply {
                put("settingsJson", entry.settingsJson)
                put("modelDir", entry.modelDir)
                entry.idleMotionGroup?.let { put("idleMotionGroup", it) }
                put("idleBeatGroups", entry.idleBeatGroups)
                put("targetFps", ScreensaverPrefs.getScreensaverFps(ctx))
                // 壁纸是合成最底层，透明处只会显示黑色，故不透明清屏由背景色铺满
                put("backgroundColor", "#000000")
                entry.layout?.let { put("layout", it) }
            }

            c.showModel(opts) { result, error ->
                if (result == null) {
                    Log.e(TAG, "wallpaper showModel failed: $error")
                } else {
                    Log.i(TAG, "wallpaper model ready: ${entry.avatarId}")
                }
                // showModel 会把 host 置为可见——若此刻壁纸其实不可见，这里纠正回去
                applyVisibility()
            }
        }
    }

    private companion object {
        const val TAG = "Live2DWallpaper"
    }
}
