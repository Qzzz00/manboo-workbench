package com.llm.live2d;

import android.os.Bundle;
import android.os.PowerManager;
import android.view.WindowManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    public static final String EXTRA_OPEN_HANDHELD_SETTINGS = "aibooOpenHandheldSettings";
    public static final String EXTRA_HANDHELD_SETTINGS_ORIGIN = "aibooHandheldSettingsOrigin";
    /**
     * 本 flavor 是不是「电台桌面」。
     *
     * <p>BuildConfig.IS_LAUNCHER 只说明「我是桌面」，两种桌面（u3 电台 / handheld 掌机）都为 true。
     * 播放服务与白屏看门狗是电台独有的，必须用这个更细的判据把关——否则掌机桌面会莫名拉起
     * 一个 RadioPlaybackService，看门狗也会因为掌机根不置 window.__aibooRadioMounted 而白白
     * reload 四次 WebView。
     */
    private static final boolean IS_RADIO_LAUNCHER = "radio".equals(BuildConfig.LAUNCHER_KIND);

    private PowerManager.WakeLock wakeLock;
    // 上次派发给 JS 的键盘可视高度（物理 px，已减导航栏），去重用——insets/动画回调
    // 触发很频繁，只有真实变化（动画逐帧、模式切换）才注入 JS。
    private int lastKbPx = -1;

    /**
     * 把键盘可视高度（CSS px）派发给 JS。src=0 表示 insets 跳变上报（本 ROM：动画起点
     * 即终值、无中间帧）；src=1 表示 WindowInsetsAnimation 逐帧流（支持 inset 动画的 ROM，
     * JS 脱离 transition 直贴键盘顶）。visualViewport 低报（本机 270 vs 实际 317），
     * ime() 是权威值；键盘停在导航栏上方时 ime 含导航栏高，必须减掉。
     */
    /**
     * 渲染进程死后自重启：拆掉已经不可用的 WebView 宿主，延迟一秒半把自己重新拉起来。
     *
     * 延迟是必要的——立刻重启会撞上系统正在回收渲染进程，新起来的往往当场又死一次。
     */
    private void scheduleSelfRestart() {
        try {
            android.content.Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (intent != null) {
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    | android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK);
                android.app.PendingIntent pending = android.app.PendingIntent.getActivity(
                    this, 0, intent, android.app.PendingIntent.FLAG_CANCEL_CURRENT);
                android.app.AlarmManager alarm =
                    (android.app.AlarmManager) getSystemService(android.content.Context.ALARM_SERVICE);
                if (alarm != null) {
                    alarm.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 1500, pending);
                }
            }
        } catch (Throwable ignored) {
            // 排不上重启也要走下面的退出：留着一个渲染器已死的空壳没有意义。
        }
        finish();
        System.exit(0);
    }

    private void dispatchKbHeight(int kbPx, int src) {
        if (kbPx == lastKbPx) return;
        lastKbPx = kbPx;
        if (bridge == null) return;
        WebView wv = bridge.getWebView();
        if (wv == null) return;
        int css = Math.round(kbPx / getResources().getDisplayMetrics().density);
        wv.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('aiboo:ime',{detail:{height:" + css + ",src:" + src + "}}))",
            null);
    }
    // U3 电台桌面白屏自愈看门狗：这台 careai/MTK ROM 的 WebView 渲染子进程偶发起不来，
    // 且 MainActivity 是 singleTask+HOME，被任务复用时 Capacitor 不重新 loadUrl → 空白 WebView。
    // 冷启后若前端 window.__aibooRadioMounted 未置位，reload WebView 直到画出来（最多 4 次）。
    private final android.os.Handler radioWatchdog =
        new android.os.Handler(android.os.Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate（加载页面）之前注册，window.Capacitor 上才能立即拿到 DjState 插件。
        registerPlugin(DjStatePlugin.class);
        registerPlugin(ScreensaverPlugin.class);
        registerPlugin(WidgetPlugin.class);
        // 展示台来电铃声（来电链 v0）：ring 起铃 / offhook·missed 停铃
        registerPlugin(RingtonePlugin.class);
        // 低端机原生 Live2D 渲染层（透明 WebView 下垫 GLSurfaceView 跑 Cubism）
        registerPlugin(com.llm.live2d.nativelive2d.NativeLive2DPlugin.class);
        // 桌宠浮窗：悬浮窗 overlay 控制（SAW 授权 + start/stop + 尺寸）
        registerPlugin(OverlayPlugin.class);
        registerPlugin(RadioLauncherPlugin.class);
        // 掌机桌面：扫 ROM 目录 + 用 RetroArch 直接开游戏
        registerPlugin(HandheldPlugin.class);
        // 掌机军师：无障碍截屏 + 麦克风权限。★本地插件（非 npm 包）不会被自动发现，
        // 漏这一行的症状是 JS 侧 registerPlugin 照样给出代理对象，调用时才报
        // "Strategist plugin is not implemented on android"（真机实测踩过）。
        registerPlugin(StrategistPlugin.class);
        // 桌宠浮窗的前后台状态源：统计本进程前台 Activity 数，普通桌宠据此在 App 前台时自动隐藏
        // （否则回 App 后浮窗角色 + 舞台角色同屏两个模型）。只注册一次（Activity 重建不重复挂）。
        if (!Live2DOverlayService.activityWatcherRegistered) {
            Live2DOverlayService.activityWatcherRegistered = true;
            getApplication().registerActivityLifecycleCallbacks(new android.app.Application.ActivityLifecycleCallbacks() {
                @Override public void onActivityResumed(android.app.Activity activity) {
                    Live2DOverlayService.foregroundActivities++;
                    Live2DOverlayService.onAppForegroundChanged();
                }
                @Override public void onActivityPaused(android.app.Activity activity) {
                    Live2DOverlayService.foregroundActivities = Math.max(0, Live2DOverlayService.foregroundActivities - 1);
                    Live2DOverlayService.onAppForegroundChanged();
                }
                @Override public void onActivityCreated(android.app.Activity activity, android.os.Bundle b) {}
                @Override public void onActivityStarted(android.app.Activity activity) {}
                @Override public void onActivityStopped(android.app.Activity activity) {}
                @Override public void onActivitySaveInstanceState(android.app.Activity activity, android.os.Bundle b) {}
                @Override public void onActivityDestroyed(android.app.Activity activity) {}
            });
        }
        super.onCreate(savedInstanceState);

        // 屏幕常亮（桌面常驻终端）。用窗口标志而不是改 Settings.System.SCREEN_OFF_TIMEOUT：
        // 作用域仅限本 App 窗口，退到后台/退出即自动失效，不会篡改用户系统设置、无需还原清单。
        if (BuildConfig.KEEP_SCREEN_ON) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }

        // ★不要在这里做音量流干预（setVolumeControlStream / 拦截 KEYCODE_VOLUME_*）——试过，是错的。
        // holo 常开麦克风 → WebView 有活跃 WebRTC 输入 → Chrome 把**媒体输出一并挪到通话流**。
        // 真机实证：音乐在响时 `dumpsys audio` 报 isMusicActive=false，出声的是带
        // usage=USAGE_VOICE_COMMUNICATION 的 OpenSL AudioTrack。
        // 也就是说系统把音量键路由到「通话音量」是**正确的**——那才是声音所在的流。
        // 曾把按键强制改调 STREAM_MUSIC，结果调的是一条没在出声的流，音量键彻底失效（Ben 实报）。
        // 系统默认路由（getActiveStreamType 自动选活跃流）才是对的，保持不动。
        // 非空 WEB_ENTRY 的 flavor（如 tsv=holo.html）走独立 vite 入口而不是手机主界面。
        // Capacitor 在 super.onCreate 里已把 index.html 载入，这里紧接着改导航即可。
        if (BuildConfig.WEB_ENTRY != null && !BuildConfig.WEB_ENTRY.isEmpty()) {
            WebView wv0 = getBridge() != null ? getBridge().getWebView() : null;
            if (wv0 != null) {
                // ★常驻展示类宿主（tsv/display）没有人去点屏幕，拿不到「用户手势」，
                // WebView 默认的自动播放策略会把电台音频挡死（表现为 UI 停在
                // 「电台准备中」但一直没声音）。悬浮窗与屏保两个宿主早就关了这个开关
                // （OverlayWindow.kt / Live2DDreamService.kt），主 WebView 一直漏了。
                // 只对 WEB_ENTRY 非空的 kiosk flavor 生效，手机/掌机行为不变。
                wv0.getSettings().setMediaPlaybackRequiresUserGesture(false);
                // 诊断通道：把 JS 侧 djTrace 直送 logcat。Capacitor 不把 console 转发到
                // logcat（真机实测 grep 不到任何 Console 行），而 CDP 在这台机器上
                // Runtime.evaluate 常不返回，所以留一条自己的桥，故障时才有据可查。
                wv0.addJavascriptInterface(new Object() {
                    @android.webkit.JavascriptInterface
                    public void log(String msg) { android.util.Log.i("DJTRACE", msg); }
                }, "AibooTrace");

                // ★渲染进程死掉不能连整个 app 一起拖走。
                //
                // 2026-08-20 真机实录：跑了约 47 分钟后渲染进程先报
                // `pthread_create: Try again`（建不出线程了），随后被 OOM 干掉，
                // WebView 的 aw_browser_terminator 直接把宿主 abort——屏幕全黑，
                // 要人去手动拉起来。常驻大屏不能是这个行为。
                //
                // Capacitor 的 WebViewListener 就是为此留的口子：返回 true 表示
                // 「我处理了」，系统就不会杀 app。渲染器死掉的 WebView 不能再用，
                // 所以这里安排一次自重启，让它自己回来。
                //
                // 注意这只是**兜底**：它让崩溃从"黑屏等人"变成"眨一下眼自己回来"，
                // 并不解决为什么会 OOM。根因另查。
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    getBridge().addWebViewListener(new WebViewListener() {
                        @Override
                        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                            boolean crashed = detail != null && detail.didCrash();
                            android.util.Log.e("AibooDisplay",
                                "渲染进程死亡（didCrash=" + crashed + "），自行重启，不让宿主被 abort");
                            scheduleSelfRestart();
                            return true;
                        }
                    });
                }
                android.util.Log.i("AibooDisplay", "onCreate autoplay disabled"
                    + " wv=" + Integer.toHexString(System.identityHashCode(wv0))
                    + " readback=" + wv0.getSettings().getMediaPlaybackRequiresUserGesture());
                wv0.loadUrl("http://localhost/" + BuildConfig.WEB_ENTRY);
            }
        }
        // U3 电台桌面专属：预启播放服务（无播放时不占前台；播放触发时由 media3 提升为前台服务）
        // + 白屏自愈看门狗。掌机桌面两样都不要。
        if (IS_RADIO_LAUNCHER) {
            startService(new android.content.Intent(this, RadioPlaybackService.class));
            startRadioMountWatchdog();
        }

        if (!BuildConfig.IS_LAUNCHER) {
            // 禁止 WebView 随键盘收缩：Capacitor SystemBars 在 Android 15+ 会给 WebView 父容器
            // 加 IME 底部 padding（等效 adjustResize，本机 867→549）。窗口一缩，钉在文档底的
            // 输入栏面板瞬间掉出窗口，键盘滑上来之前露出 GL 层（杂色空档）。替换掉它的
            // listener：永不吃 IME padding —— WebView 恒全高，面板静止钉底，键盘上下滑盖
            // （微信式），composer 偏移由 JS visualViewport 驱动。
            android.view.View wvParent = (android.view.View) bridge.getWebView().getParent();
            final WebView webView = bridge.getWebView();
            final float imeDensity = getResources().getDisplayMetrics().density;
            // JS 侧冷启竞态兜底：aiboo:ime 事件只在高度变化时派发，页面后加载会错过首值，
            // 暴露同步接口让 JS 随时拉取当前键盘可视高度（CSS px）。
            webView.addJavascriptInterface(new Object() {
                @android.webkit.JavascriptInterface
                public int getImeHeightCss() {
                    return Math.round(Math.max(0, lastKbPx) / imeDensity);
                }
            }, "AibooIme");
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(wvParent, (v, insets) -> {
                v.setPadding(0, 0, 0, 0);
                int imePx = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom;
                int navPx = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars()).bottom;
                dispatchKbHeight(Math.max(0, imePx - navPx), 0);
                return insets;
            });
            // 支持 inset 逐帧动画的 ROM：键盘升/降期间逐帧下发高度（src=1），JS 直贴键盘顶；
            // 本机这类跳变 ROM 不会回调这里，走上面的 insets 单帧路径，行为不变。
            androidx.core.view.ViewCompat.setWindowInsetsAnimationCallback(wvParent,
                // dispatchMode=1 即 DISPATCH_MODE_CONTINUE_ON_SUBDIVISION（本项目 core 版本
                // 编译期找不到该常量，直接传字面量）
                new androidx.core.view.WindowInsetsAnimationCompat.Callback(1) {
                    @Override
                    public androidx.core.view.WindowInsetsCompat onProgress(
                            androidx.core.view.WindowInsetsCompat insets,
                            java.util.List<androidx.core.view.WindowInsetsAnimationCompat> runningAnimations) {
                        int imePx = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom;
                        int navPx = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars()).bottom;
                        dispatchKbHeight(Math.max(0, imePx - navPx), 1);
                        return insets;
                    }
                });
            // 替换监听器后补一次 insets 请求，保证首帧就能拿到当前键盘状态
            androidx.core.view.ViewCompat.requestApplyInsets(wvParent);
        }
        // 两种桌面都要沉浸全屏：桌面页自绘了状态栏（WiFi/蓝牙/时间/电量），不隐藏系统栏的话
        // 两条状态栏在真机上重叠显示两遍时间/电量（真机截图实锤）。phone flavor 不受影响。
        if (BuildConfig.IS_LAUNCHER) {
            hideSystemBars();
        }
        dispatchHandheldIntent(getIntent());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 沉浸式标志会被系统手势/下拉状态栏等临时打断，重新获焦时补回。
        if (hasFocus && BuildConfig.IS_LAUNCHER) hideSystemBars();
    }

    private void hideSystemBars() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                    | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        // singleTask+HOME 复用走 onNewIntent 而非 onCreate：Capacitor 不会重新 loadUrl，
        // 若复用到的是被系统回收后重建的空 WebView 就会白屏，这里同样启动看门狗兜底。
        // 只对电台：看门狗探的是 window.__aibooRadioMounted，掌机根不置这个位。
        if (IS_RADIO_LAUNCHER) {
            startRadioMountWatchdog();
        }
        dispatchHandheldIntent(intent);
    }

    private void dispatchHandheldIntent(android.content.Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_OPEN_HANDHELD_SETTINGS, false)) return;
        if (bridge == null) return;
        WebView wv = bridge.getWebView();
        if (wv == null) return;
        // 这个 extra 来自本进程，仍只接受白名单值，避免把任意 Intent 字符串拼进 JS。
        String origin = "home".equals(intent.getStringExtra(EXTRA_HANDHELD_SETTINGS_ORIGIN))
            ? "home"
            : "game";
        // 冷启动时 evaluateJavascript 可能先打到 about:blank，随后 Capacitor 再加载前端页面；
        // 连发几次短重试，并用 token 保证同一个 intent 在同一个 JS 上下文只消费一次。
        long token = android.os.SystemClock.uptimeMillis();
        postHandheldOpenSettings(wv, token, origin, 0);
        postHandheldOpenSettings(wv, token, origin, 350);
        postHandheldOpenSettings(wv, token, origin, 1200);
    }

    private void postHandheldOpenSettings(WebView wv, long token, String origin, long delayMs) {
        wv.postDelayed(() -> wv.evaluateJavascript(
            "(function(){var t=" + token + ";"
                + "if(window.__aibooHandheldSettingsIntentToken===t)return;"
                + "window.__aibooHandheldSettingsIntentToken=t;"
                + "window.__aibooHandheldOpenSettings?window.__aibooHandheldOpenSettings('" + origin + "')"
                + ":(window.__aibooPendingHandheldOpenSettings='" + origin + "')"
                + "})()",
            null
        ), delayMs);
    }

    /** 3 秒后开始探测前端是否挂载成功，未挂载则 reload WebView 自愈（最多 4 次，每次间隔 3 秒）。 */
    private void startRadioMountWatchdog() {
        radioWatchdog.removeCallbacksAndMessages(null);
        radioWatchdog.postDelayed(() -> checkRadioMounted(0), 3000);
    }

    private void checkRadioMounted(int attempt) {
        if (bridge == null) return;
        WebView wv = bridge.getWebView();
        if (wv == null) return;
        wv.evaluateJavascript("(window.__aibooRadioMounted===1)", value -> {
            if ("true".equals(value)) return; // 已画出电台，收工
            if (attempt >= 4) return;          // 兜底上限，避免无限 reload
            String url = wv.getUrl();
            if (url != null && url.startsWith("http")) {
                wv.reload();                  // 页面在但没跑起来（渲染进程 race）→ reload
            } else {
                wv.loadUrl("http://localhost"); // 空白/about:blank（URL 没加载）→ 重新导航到应用入口
                                                // capacitor.config androidScheme='http' → http://localhost
            }
            radioWatchdog.postDelayed(() -> checkRadioMounted(attempt + 1), 3000);
        });
    }

    @Override
    public void onPause() {
        super.onPause();
        // 以下 WebView 强恢复 + 唤醒锁是手机端 WebView 音频（DJ 口播定时器）的手改逻辑。
        // 两种桌面都不需要：u3 电台播放走原生 RadioPlaybackService（media3 前台服务，不依赖
        // WebView 定时器/JS 回调），掌机桌面根本不放音频。对它们纯粹是无效唤醒锁、只耗电，
        // 用 IS_LAUNCHER 一并跳过；phone 分支行为不变。
        if (!BuildConfig.IS_LAUNCHER) {
            // 锁屏/切后台时强制恢复 WebView，避免 Android 冻结 JS 定时器与音频回调，
            // 这样 DJ 口播播完后能继续触发下一段。
            if (bridge != null) {
                WebView wv = bridge.getWebView();
                if (wv != null) {
                    wv.onResume();
                    wv.resumeTimers();
                }
            }
            // 获取部分唤醒锁，防止 CPU 进入深度休眠导致 WebView 被挂起。
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "Aiboo::AudioWakeLock"
                );
                wakeLock.acquire(30 * 60 * 1000L); // 30 分钟上限，超时自动释放
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // 常驻展示宿主（tsv/display）没人点屏幕，拿不到「用户手势」，这里兜底重设一次。
        // ★纠正一条曾被写进交接文档的错误结论：「onCreate 设了不生效、Capacitor 会重配
        // WebView」是**假的**。加上 hashCode + readback 打点后真机实测：onCreate 与
        // onResume 拿到的是同一个实例（wv=4a27ed），且 onCreate 时 readback 就已经是
        // false（= 不要求手势）。也就是说自动播放策略从来就没挡住过展示台。
        // 「一首接一首跳曲」的真正病根是 DisplayApp 多传了 preferWebAudio:true —— 音乐被
        // 绕进 AudioContext，而 ctx 在无手势时停在 suspended，setMediaPlaybackRequiresUserGesture
        // 解不了 AudioContext 的挂起（那次手动 tap 之所以救活，是 tap 触发了 ctx.resume()）。
        // 这一段留着无害，纯属防御；真正的修复在 DisplayApp 的 DJ 配置与 holo 对齐。
        if (BuildConfig.WEB_ENTRY != null && !BuildConfig.WEB_ENTRY.isEmpty()) {
            WebView wvAuto = getBridge() != null ? getBridge().getWebView() : null;
            if (wvAuto != null) {
                wvAuto.getSettings().setMediaPlaybackRequiresUserGesture(false);
                // 读回来确认这次真的写进了「当前这个」WebView 实例：只打印「已调用」证明不了
                // 什么（onCreate 那次就是调了但没生效）。hashCode 用来和 onCreate 时的实例
                // 比对——若两者不同，说明 Capacitor 之后换过 WebView，那才是真正的病根。
                android.util.Log.i("AibooDisplay", "autoplay gesture requirement disabled"
                    + " wv=" + Integer.toHexString(System.identityHashCode(wvAuto))
                    + " readback=" + wvAuto.getSettings().getMediaPlaybackRequiresUserGesture());
            }
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
        // U3 电台桌面：无密码 keyguard 唤醒即散——配合 showWhenLocked 消灭锁屏层。
        // 掌机不是该锁屏宿主；若也调 requestDismissKeyguard，RG Rotate 会把首个 Surface 延后约十秒。
        if (LauncherStartupPolicy.shouldRequestKeyguardDismissal(BuildConfig.LAUNCHER_KIND)
            && android.os.Build.VERSION.SDK_INT >= 26) {
            android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        }
        if (BuildConfig.IS_LAUNCHER) hideSystemBars();
        // 曾试过 startLockTask()（Screen Pinning）压住边缘滑出的系统栏，真机验证没压住，
        // 反而在导航栏区多出一个「解除固定」提示图标——已撤销。彻底解决需要 Device Owner
        // 模式（更彻底但需要设备预配置，见 CLAUDE.md/记忆里的讨论，待 Ben 决定是否要做）。
    }

}
