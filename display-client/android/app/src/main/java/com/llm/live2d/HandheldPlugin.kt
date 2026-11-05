package com.llm.live2d

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StrictMode
import android.provider.Settings
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * 掌机桌面（Anbernic RG Rotate）JS 桥：扫 ROM 目录 + 用 RetroArch 直接开一款游戏。
 *
 * 与 RadioLauncherPlugin 分开是有意的：那个是电台桌面的（音乐扫描/播放控制/应用抽屉），
 * 塞掌机的 ROM 逻辑进去会让两个产品的边界糊掉。三个 flavor 都会编译注册本插件，
 * 但只有掌机根会调它。
 */
@CapacitorPlugin(name = "Handheld")
class HandheldPlugin : Plugin() {

    companion object {
        private const val TAG = "HandheldPlugin"

        /**
         * RetroArch 启动配方（2026-07-30 真机逐步验证定稿）：
         *
         *   目标 = RetroActivityFuture（仿真层），
         *   extras = ROM + LIBRETRO + CONFIGFILE=<Android/data 下的真配置>。
         *
         * ★CONFIGFILE 必须指真配置且一个 extra 都不能少——三种错法都在这台机上实翻过车：
         *   ①不带 CONFIGFILE 直启 → native 落到内部默认配置：存档路径/viewport/语言全默认，
         *     表现=存档「消失」、画面不顶、菜单全 ????（其实什么都没丢，读错了地方）。
         *   ②CONFIGFILE 指 /RetroArch/config/retroarch.cfg → 那是次要拷贝不是真配置，
         *     且「退出时配置保存」（该机已启用）会把会话状态回写进去毁用户设置
         *     （custom_viewport_y 0→120 实锤）。真配置路径是从原厂桌面 RetroGame.apk 的
         *     dex 里逆向出来的（Android/data 那份）；指对文件后，退出回写=与用户正常使用
         *     完全相同的行为，不再是破坏。
         *   ③目标换 MainMenuActivity（RetroArch 自己的前端）→ 配置能正确加载
         *     （中文菜单/外置存档路径实证），但这版前端不转发 ROM/LIBRETRO extras，
         *     结果只开菜单不进游戏（顶栏「没有核心」实证）。
         * 最终配方验证链：进游戏 + 顶部对齐（用户 viewport 生效）+ 中文菜单，逐项截图实证。
         *
         * ★永远不要 am force-stop RetroArch（来不及刷配置与 SRAM）；它已在跑别的游戏时
         * intent 会被现有会话吞掉（原厂同语义：先退出再选新游戏）。
         */
        private const val RETROARCH_PKG = "com.retroarch.aarch64"
        private const val RETROARCH_ACTIVITY = "com.retroarch.browser.retroactivity.RetroActivityFuture"
        private const val RETROARCH_CONFIGFILE =
            "/storage/emulated/0/Android/data/com.retroarch.aarch64/files/retroarch.cfg"

        /**
         * RetroArch 核心与配置的路径。核心装在 RetroArch 的私有目录里，外部读不到（也不需要读）——
         * 只是把路径字符串交给 RetroArch 自己去 dlopen，实测 avc 授予 execute 成功。
         * 装了哪些核心可以看 /storage/emulated/0/RetroArch/config/ 下的同名文件夹
         * （该机现有 gpSP 与 mGBA 两个 GBA 核心）。
         */
        private const val RETROARCH_CORE_DIR = "/data/data/$RETROARCH_PKG/cores/"

        /**
         * DuckStation（PS1）。manifest 里**只有 MainActivity 带 MAIN/LAUNCHER**，没有接收文件的
         * intent-filter，所以没有「用 VIEW 打开文件」那条公开协议。但 EmulationActivity 在它自己的
         * manifest 里写着 **android:exported="true"**——按组件名直接拉起是它允许的用法，不是野路子。
         *   extra 用 `path` / `filename` / `startFile` / `file` → 都只进 BIOS 菜单（没载入光盘）
         *   extra 用 **`bootPath`** → 真进游戏 ✓（`saveStatePath` 是它的姊妹 extra，可选）
         * BIOS 不用传，DuckStation 从自己的设置里找（Ben 的放在 /duckstation/bios/）。
         *
         * ★2026-07-31 翻案：这里一度改成「不深启、只打开 App 本体」，依据是 7-29 记下的
         * 「直启会跳过 MainActivity 初始化 → BIOS 选择不生效 → 猫犬协奏曲中文乱码」。该结论**不成立**：
         *   · 反编译设备上这版 APK（0.1-8256-g7228f6f1c）：EmulationActivity 自己就调 `initializeOnce`，
         *     并不依赖 MainActivity 先跑。MainActivity 独有的只是 setDefaultSettings /
         *     setDefaultPadSettings / hasAnyBIOSImages 这类「首次运行铺默认值 + 引导去 SetupWizard」。
         *   · 真机实测直启：开场动画中文字幕「漂浮在天空之中」完全正常，无乱码。
         * 当年那次乱码大概率是 DuckStation 当时还没配好 BIOS，与启动方式无关。
         * 教训：把一次现场观察写成「机制结论」，会让后面的人（包括我）照着它做出错误的退让。
         */
        private const val DUCKSTATION_PKG = "com.github.stenzek.duckstation"
        private const val DUCKSTATION_ACTIVITY = "com.github.stenzek.duckstation.EmulationActivity"
        private const val DUCKSTATION_ROM_EXTRA = "bootPath"

        /**
         * DraStic（NDS）。它比 DuckStation 规矩：manifest 里就有 ACTION_VIEW + scheme=file +
         * `*.nds` 的 glob filter，所以走标准的「用 VIEW 打开一个文件」即可，不用猜 extra 名。
         * 2026-07-29 在 ROTATE02739640 上实测拉起天空机器人成功。
         */
        private const val DRASTIC_PKG = "com.dsemu.drastic"
        private const val DRASTIC_ACTIVITY = "com.dsemu.drastic.DraSticActivity"

        /**
         * PPSSPP（PSP）。与 DraStic 一样规矩：manifest 里 PpssppActivity 自带
         * ACTION_VIEW + scheme=file/content + `*.iso`/`*.cso`/`*.chd`/`*.elf` 的 glob filter
         * （2026-07-31 在 ROTATE02739640 上 dumpsys 实读），所以走标准「用 VIEW 打开一个文件」，
         * 不用猜 extra 名。
         * ★它的 filter **没有声明 mimeType**——别学 DraStic 那样连 mime 通配一起 setDataAndType。
         *   （我们用显式组件、本来就不走 filter 匹配，但保持与它自己的调用方式一致更稳。）
         * ROM 摆在 /PSP/ISO/ 下：那是 PPSSPP 自建的目录结构，见 handheldRoms.ts 的 ROM_SOURCES。
         */
        private const val PPSSPP_PKG = "org.ppsspp.ppsspp"
        private const val PPSSPP_ACTIVITY = "org.ppsspp.ppsspp.PpssppActivity"
    }

    /**
     * 列出某个目录下的 ROM。
     *
     * opts: { dir: String（相对外部存储根，如 "GBA"）, extensions: String[]（如 ["gba"]） }
     * 返回: { roms: [{ path, fileName, sizeBytes }], dir, readable }
     *
     * ★最多下探一层子目录（maxDepth 默认 2 = 本层 + 子目录）。理由是两种真实摆法都要支持：
     *   /GBA/xxx.gba              扁平摆（Ben 的 GBA 就是这样）
     *   /PS1/猫犬协奏曲/xxx.bin    一游戏一文件夹（PS1 常见，光盘镜像常带多个配套文件）
     * 但**不做无限递归**：ROM 目录里常有模拟器自建的存档/金手指目录
     * （该机 /GBA 下就有个 mGBA 文件夹），挖太深只会捞出一堆无关文件。
     */
    @PluginMethod
    fun listRoms(call: PluginCall) {
        val dirName = call.getString("dir") ?: run {
            call.reject("dir required"); return
        }
        val extensions = call.getArray("extensions")?.toList<String>()
            ?.map { it.lowercase().removePrefix(".") }
            ?.toSet()
            ?: emptySet()
        val maxDepth = call.getInt("maxDepth") ?: 2

        val root = File(Environment.getExternalStorageDirectory(), dirName)
        val result = JSObject().put("dir", root.absolutePath)

        if (root.listFiles() == null) {
            // 目录不存在、或分区存储把我们挡在外面。两者对前端是同一种结果：没得列。
            // 不 reject——桌面上「读不到游戏」应该是空态而不是异常。
            Log.w(TAG, "listRoms: cannot list ${root.absolutePath} (missing or no permission)")
            call.resolve(result.put("readable", false).put("roms", JSArray()))
            return
        }

        val found = mutableListOf<File>()
        collectRoms(root, extensions, maxDepth, found)

        val roms = JSArray()
        found.sortedBy { it.name.lowercase() }.forEach { f ->
            roms.put(
                JSObject()
                    .put("path", f.absolutePath)
                    .put("fileName", f.name)
                    .put("sizeBytes", f.length()),
            )
        }
        Log.i(TAG, "listRoms: ${root.absolutePath} -> ${roms.length()} roms (depth=$maxDepth)")
        call.resolve(result.put("readable", true).put("roms", roms))
    }

    private fun collectRoms(dir: File, extensions: Set<String>, depthLeft: Int, out: MutableList<File>) {
        if (depthLeft <= 0) return
        val entries = dir.listFiles() ?: return
        for (f in entries) {
            if (f.isFile) {
                if (extensions.isEmpty() || extensions.contains(f.extension.lowercase())) out.add(f)
            } else if (f.isDirectory) {
                collectRoms(f, extensions, depthLeft - 1, out)
            }
        }
    }

    /**
     * 用 RetroArch 直接开一款游戏。
     *
     * opts: { path: String（ROM 绝对路径）, core: String（核心文件名，如 "mgba_libretro_android.so"）,
     *         switchApp?: String（换游戏前要杀掉的模拟器包名，见「换游戏」一节） }
     *
     * RetroArch 配方见 RETROARCH_CONFIGFILE 注释；DuckStation 暂不深启（见分支内注释）；
     * DraStic 走它 manifest 自己声明的 VIEW+file:// 正规入口。
     *
     * ★★换游戏（2026-07-30 逆向原厂 + 真机逐步验证定稿）。
     * 症结：模拟器的仿真 Activity 是常驻单例，玩着 A 回桌面点 B，新 intent 被 A 的会话吞掉，
     * 它只在 onCreate 读 ROM extra、onNewIntent 不处理 → 开出来还是 A。
     *
     * 原厂桌面 RetroGame.apk（=com.ylm.launcher，system uid）的做法（dex 逆向）：
     *   先探 isRetroArchRunning → 弹「新游戏/旧游戏」框 → 选新游戏就
     *   反射 ActivityManager.forceStopPackage(模拟器包) 杀掉整个进程，再 startActivity。
     *   ★它的 intent flags 只有 NEW_TASK，根本不靠 CLEAR_TASK/CLEAR_TOP。
     *
     * 我们够不着 forceStopPackage（要 system uid），退而用普通权限
     * killBackgroundProcesses（manifest 已声明 KILL_BACKGROUND_PROCESSES）。真机验证矩阵：
     *   · 只 CLEAR_TASK 不杀进程 → RetroArch 原生主循环不响 onDestroy → destroy timeout
     *     → 永久卡启动 logo（比原 bug 更坏）。★所以单靠 flag 这条路是死的。
     *   · 只杀进程不 CLEAR_TASK → task 活得比进程久，被系统用**旧 intent** 重建 → 还是旧游戏。
     *   · 先杀进程 + NEW_TASK|CLEAR_TASK → 正反两个方向 + 零延时都开出新游戏 ✓（截图实证）。
     *     （此时也可能刷一条 destroy timeout 警告，但那只是孤儿 ActivityRecord 的日志噪音，
     *      进程已经先没了，不是上面那个死锁。）
     *
     * 存档安全（读该机 retroarch.cfg 实证）：savestate_auto_save/auto_load 皆 false，
     * autosave_interval=10（SRAM 每 10 秒落盘）→ 杀进程不写不覆盖任何存档，等价于「存档后关掉」。
     *
     * switchApp 由前端在「确实要换一个不同模拟器/ROM」时传（同一个游戏点第二次不该传，
     * 那只是把它切回前台，不该杀）。不传 = 老语义（NEW_TASK|CLEAR_TOP，不杀）。
     */
    @PluginMethod
    fun launchRom(call: PluginCall) {
        val path = call.getString("path") ?: run { call.reject("path required"); return }
        val app = call.getString("app") ?: "retroarch"
        // 换游戏：先杀掉还跑着旧 ROM 的模拟器进程。null=不换（同一游戏切回前台 / 冷启动）。
        val switchApp = call.getString("switchApp")

        val rom = File(path)
        if (!rom.isFile) {
            call.reject("rom not found: $path")
            return
        }

        if (switchApp != null) killEmulatorProcess(switchApp)

        val intent = Intent().apply {
            when (app) {
                "duckstation" -> {
                    // 深启 EmulationActivity + bootPath（配方与翻案证据见 DUCKSTATION_ACTIVITY 注释）。
                    setClassName(DUCKSTATION_PKG, DUCKSTATION_ACTIVITY)
                    putExtra(DUCKSTATION_ROM_EXTRA, path)
                }
                "retroarch" -> {
                    val core = call.getString("core")
                    if (core == null) { call.reject("core required for retroarch"); return }
                    // 配方与三种错法的实翻记录见 RETROARCH_CONFIGFILE 常量的注释，勿删减 extras
                    setClassName(RETROARCH_PKG, RETROARCH_ACTIVITY)
                    putExtra("ROM", path)
                    putExtra("LIBRETRO", RETROARCH_CORE_DIR + core)
                    putExtra("CONFIGFILE", RETROARCH_CONFIGFILE)
                }
                "drastic" -> {
                    // DraStic 走标准 ACTION_VIEW + file:// URI（它自己声明了这个 filter）。
                    // ★file:// 跨应用传递在 API24+ 会触发 FileUriExposedException，
                    // 但 DraStic 的 filter 写死 scheme="file"，用 FileProvider 的 content:// 它不认。
                    // 所以只能放宽本进程的 VmPolicy——只影响我们自己，且这是启动器的正常用法。
                    StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().build())
                    action = Intent.ACTION_VIEW
                    setDataAndType(Uri.fromFile(rom), "*/*")
                    setClassName(DRASTIC_PKG, DRASTIC_ACTIVITY)
                }
                "ppsspp" -> {
                    // 同 DraStic：ACTION_VIEW + file:// URI，它自己声明了 *.iso/*.cso filter。
                    // file:// 的 VmPolicy 放宽同理（它的 filter 也收 content:，但那要 FileProvider
                    // 授权链，而 ROM 就在公共存储上、file: 直给最简单，与 DraStic 保持一致）。
                    // ★不设 mime type：它的 filter 没声明 mimeType（见 PPSSPP_ACTIVITY 注释）。
                    StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().build())
                    action = Intent.ACTION_VIEW
                    data = Uri.fromFile(rom)
                    setClassName(PPSSPP_PKG, PPSSPP_ACTIVITY)
                }
                else -> { call.reject("unknown app: $app"); return }
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // 换游戏时 CLEAR_TASK 清掉残留 task（否则被旧 intent 重建=还是旧游戏，真机实锤）；
            // 进程已先杀掉，不会撞上「原生主循环不响 onDestroy」那个死锁。
            // 不换游戏时只 CLEAR_TOP（老语义，冷启动/同一游戏切前台）。
            if (switchApp != null) addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
            else addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        try {
            context.startActivity(intent)
            Log.i(TAG, "launchRom: $path via $app (switchApp=$switchApp)")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "launchRom failed", e)
            call.reject("launch failed: ${e.message}")
        }
    }

    /**
     * 杀掉某个模拟器进程（换游戏前）。
     * killBackgroundProcesses 只杀 oom_adj>=500 的进程——刚退到后台的模拟器 1 秒内落到 700
     * （真机实测），可杀；前台进程杀不动（框架静默跳过）。换游戏时模拟器必在后台，满足条件。
     * SRAM 已落盘（autosave_interval=10）、savestate 自动存关闭 → 杀进程不伤存档。
     */
    private fun killEmulatorProcess(pkg: String) {
        try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
            am?.killBackgroundProcesses(pkg)
            Log.i(TAG, "killEmulatorProcess: $pkg")
        } catch (e: Exception) {
            // 杀不掉（无权限/系统拒绝）不该阻断启动——退化成老行为（可能开出旧游戏），不崩。
            Log.w(TAG, "killEmulatorProcess failed for $pkg", e)
        }
    }

    /**
     * 打开某个模拟器**本身**（不带 ROM），用于进它的设置菜单。
     *
     * opts: { app: "retroarch" | "duckstation" | "drastic" | "ppsspp" }
     *
     * 四家都是「不带 ROM 启动就落在自己的主界面/菜单」，从那里能进设置——
     * 没有哪家提供直达设置页的 intent，也不需要：少按一两下而已，
     * 而猜内部 Activity 名是会随版本碎的。
     *
     * ★这是 Ben 要的「设置入口」的一半：虚拟手柄、A/B 映射、画面对齐这些都是各模拟器
     * 自己的设置，存在它们的私有目录里，Aiboo 从外面改不了，只能把人送到门口。
     */
    @PluginMethod
    fun openEmulator(call: PluginCall) {
        val app = call.getString("app") ?: run { call.reject("app required"); return }
        val pkg = when (app) {
            "retroarch" -> RETROARCH_PKG
            "duckstation" -> DUCKSTATION_PKG
            "drastic" -> DRASTIC_PKG
            "ppsspp" -> PPSSPP_PKG
            else -> { call.reject("unknown app: $app"); return }
        }
        // 用系统给的启动 intent 而不是自己拼 Activity 名：版本升级换了入口也不会碎。
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
        if (intent == null) {
            call.reject("not installed: $pkg")
            return
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            Log.i(TAG, "openEmulator: $pkg")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "openEmulator failed", e)
            call.reject("open failed: ${e.message}")
        }
    }

    /** RetroArch 装没装（没装的话前端该提示，而不是点了没反应）。 */
    @PluginMethod
    fun isRetroArchInstalled(call: PluginCall) {
        val installed = try {
            context.packageManager.getPackageInfo(RETROARCH_PKG, 0)
            true
        } catch (e: Exception) {
            false
        }
        call.resolve(JSObject().put("installed", installed))
    }

    /**
     * 查 Aiboo 现在是不是默认桌面（设置页底部「桌面」用）。
     *
     * API29+ 用 RoleManager.isRoleHeld——直接问系统「HOME 角色现在谁持有」，权威且不弹
     * 任何 UI。更低版本没有这个 API，退化成 resolveActivity 猜：只有用户选过「始终」才准，
     * 命中系统选择器（多候选、未设默认）时包名是 resolver 自己的，会判成"不是"——这条
     * 产品线的真机是 API 31，minSdk 24 只是项目级共享下限，这个边缘情况可接受。
     */
    @PluginMethod
    fun getLauncherState(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("isDefault", isAibooHomeRole())
                .put("roleAvailable", homeRoleAvailable()),
        )
    }

    private fun homeRoleAvailable(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val rm = context.getSystemService(Context.ROLE_SERVICE) as? RoleManager ?: return false
        return rm.isRoleAvailable(RoleManager.ROLE_HOME)
    }

    private fun isAibooHomeRole(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(Context.ROLE_SERVICE) as? RoleManager
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_HOME)) {
                return rm.isRoleHeld(RoleManager.ROLE_HOME)
            }
        }
        val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val info = context.packageManager.resolveActivity(homeIntent, PackageManager.MATCH_DEFAULT_ONLY)
        return info?.activityInfo?.packageName == context.packageName
    }

    /**
     * 请求把 Aiboo 设为默认桌面。
     *
     * API29+ 走 RoleManager 官方流程：系统弹「用作主屏幕」确认框，用户选"始终"才真正生效，
     * 结果经 onRequestHomeRoleResult 回来。已经持有该角色时不弹框直接 resolve——按钮点一次
     * 已经生效的操作不该再打扰用户确认一遍。
     * 没有这个角色（真机不会，minSdk 24~28 边缘情况兜底）时退化成打开系统「主屏幕应用」
     * 设置页：fire-and-forget，那个页面不会把结果传回来，JS 侧靠 visibilitychange 时机
     * 重新查 getLauncherState 感知用户在系统 UI 里做的选择。
     */
    @PluginMethod
    fun requestSetAsLauncher(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(Context.ROLE_SERVICE) as? RoleManager
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_HOME)) {
                if (rm.isRoleHeld(RoleManager.ROLE_HOME)) {
                    call.resolve(JSObject().put("granted", true))
                    return
                }
                startActivityForResult(call, rm.createRequestRoleIntent(RoleManager.ROLE_HOME), "onRequestHomeRoleResult")
                return
            }
        }
        openHomeSettingsIntent()
        call.resolve(JSObject().put("granted", isAibooHomeRole()))
    }

    @ActivityCallback
    private fun onRequestHomeRoleResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        call.resolve(JSObject().put("granted", result.resultCode == Activity.RESULT_OK))
    }

    /** 打开系统「主屏幕应用」设置页——查看/换回其他桌面用（原厂 com.ylm.launcher / launcher3 都在这里选）。 */
    @PluginMethod
    fun openHomeSettings(call: PluginCall) {
        openHomeSettingsIntent()
        call.resolve()
    }

    private fun openHomeSettingsIntent() {
        try {
            context.startActivity(Intent(Settings.ACTION_HOME_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.e(TAG, "openHomeSettings failed", e)
        }
    }

    /**
     * 打开系统「无障碍」设置页。
     *
     * ★侧键 F10 与军师截屏共用 [AibooKeyService]，而这个授权会被**两件事**清掉：
     *   ① 重装 APK（Android 对无障碍这类敏感权限重装即撤销）
     *   ② **force-stop**（2026-07-31 logcat 实锤的新发现：force-stop 后系统会禁用
     *      该应用的无障碍服务，症状与重装一模一样——按 F10 静默没反应）
     * 掉了之后唯一的症状就是按键失效，**没有任何提示**，用户只能猜。所以设置页常驻
     * 显示状态并给这个按钮，让「✕」是可操作的，而不只是告诉他坏了。
     */
    @PluginMethod
    fun openAccessibilitySettings(call: PluginCall) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Exception) {
            Log.e(TAG, "openAccessibilitySettings failed", e)
        }
        call.resolve()
    }

    /**
     * 从游戏底条进入设置后返回原游戏。
     *
     * 设置入口通过 HOME intent 把 Aiboo task 提到了前台；游戏 task 仍完整留在它后面，
     * 不需要重启 ROM，也绝不能重新 launch（那会触发模拟器常驻 Activity 的旧游戏问题）。
     * 这里只把当前 HOME task 移到后台，让系统恢复之前的游戏 task。
     */
    @PluginMethod
    fun returnToGame(call: PluginCall) {
        val host = activity
        if (host == null) {
            call.resolve(JSObject().put("moved", false))
            return
        }
        host.runOnUiThread {
            val moved = try {
                host.moveTaskToBack(true)
            } catch (e: Exception) {
                Log.w(TAG, "returnToGame failed", e)
                false
            }
            call.resolve(JSObject().put("moved", moved))
        }
    }
}
