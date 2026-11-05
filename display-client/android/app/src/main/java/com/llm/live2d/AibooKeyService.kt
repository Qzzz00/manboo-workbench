package com.llm.live2d

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo

/**
 * 掌机实体侧键的全局监听（无 root 下 AccessibilityService 是唯一能全局收键的正道）。
 *
 * 只干一件事：右侧小键（getevent 实测 KEY_F10，2026-07-30 干净窗口 20 连击零杂音）
 * 切换底条浮窗——按一下出、再按收。Ben 的原话：「按了这个按钮就底部显示浮窗，再点就关闭」。
 *
 * ★F10 被消费掉（return true）：不消费的话前台模拟器也会收到这颗键，若它恰好绑了
 * 热键就双触发。其余所有按键一律放行（return false），游戏手感零影响。
 * ★在 Aiboo 自己前台时忽略 F10：桌面本来就有大角色，再出底条=两个原生 GL 同屏抢
 * GPU → Cubism 物理抽搐（真机实翻过）。前台包名由 typeWindowStateChanged 事件维护。
 *
 * 启用方式（一次性）：设置 → 无障碍 → Aiboo 按键；或 adb settings put secure
 * enabled_accessibility_services + accessibility_enabled 1。
 */
class AibooKeyService : AccessibilityService() {
    private var lastToggleAt = 0L
    private var foregroundPkg: String? = null

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode != KeyEvent.KEYCODE_F10) return false
        // DOWN 且非长按重复才触发；UP 与重复也要吞掉，否则半截事件漏给游戏
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return true
        val now = System.currentTimeMillis()
        if (now - lastToggleAt < 300) return true // 物理键抖动去抖
        lastToggleAt = now
        toggleStrip()
        return true
    }

    private fun toggleStrip() {
        val visible = Live2DOverlayService.isVisible
        val savedIntent = StripIntentStore.load(this)
        val action = StripKeyActionPolicy.choose(
            overlayRunning = Live2DOverlayService.isRunning,
            overlayVisible = visible,
            persistentStrip = Live2DOverlayService.isPersistentStrip,
            aibooForeground = !visible && foregroundPackageNow() == packageName,
            hasSavedIntent = savedIntent != null,
        )
        when (action) {
            StripKeyAction.PARK -> {
                Log.i(TAG, "F10 -> park strip")
                Live2DOverlayService.instance?.park()
            }
            StripKeyAction.STOP_EPHEMERAL -> {
                Log.i(TAG, "F10 -> stop ordinary overlay")
                stopService(Intent(this, Live2DOverlayService::class.java))
            }
            StripKeyAction.IGNORE -> {
                Log.i(TAG, "F10 ignored: no eligible strip presentation")
            }
            StripKeyAction.PRESENT_WARM -> {
                Log.i(TAG, "F10 -> present warm strip")
                Live2DOverlayService.instance?.present()
            }
            StripKeyAction.START_COLD -> {
                // Policy returns START_COLD only when this value is non-null.
                Log.i(TAG, "F10 -> start cold strip")
                startForegroundService(checkNotNull(savedIntent))
            }
        }
    }

    /**
     * 切换瞬间的前台包名——**必须现场查，不能信事件流**（真机双实锤，2026-07-30）：
     * ①这台 ROM 上活动 resume 不一定发 TYPE_WINDOW_STATE_CHANGED，事件流会漏掉
     *   「回到桌面」这一步（桌面上按 F10 被当成别的应用前台，起了底条→双 GL 抽搐）；
     * ②我们自己的底条窗口一出现也是一次窗口事件，会把跟踪值污染成本包名
     *   （之后所有 F10 全被「Aiboo 前台」误拦——Ben 连按五下没反应就是它）。
     * 活窗口查询没有这两个病：焦点应用窗口是谁就是谁；底条是 NOT_FOCUSABLE 的
     * overlay，永远不会成为焦点窗口。事件跟踪仅留作查询失败时的兜底。
     */
    private fun foregroundPackageNow(): String? {
        try {
            windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isFocused }
                ?.root?.packageName?.let { return it.toString() }
            rootInActiveWindow?.packageName?.let { return it.toString() }
        } catch (_: Exception) {
            /* 窗口查询在个别时机会抛（窗口正在切换），落回事件跟踪 */
        }
        return foregroundPkg
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 事件跟踪只做 foregroundPackageNow 的兜底。自家 overlay 的窗口事件必须跳过，
        // 否则污染（只有 MainActivity 的事件才代表「Aiboo 真在前台」）。
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: return
            val cls = event.className?.toString() ?: ""
            if (pkg == packageName && !cls.contains("MainActivity")) return
            foregroundPkg = pkg
        }
    }

    override fun onInterrupt() {}

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AibooKeyService"

        /**
         * 服务实例句柄。军师截屏（[ScreenCapture]）要拿它调 takeScreenshot——
         * 无障碍服务本身就是这个能力的持有者，没有别的入口。
         * null = 用户没在系统设置里启用无障碍（或刚重装 APK 被系统撤销授权，
         * 这台机上每次重装都会发生，见 README/记忆里的还原清单）。
         */
        @Volatile
        var instance: AibooKeyService? = null
    }
}
