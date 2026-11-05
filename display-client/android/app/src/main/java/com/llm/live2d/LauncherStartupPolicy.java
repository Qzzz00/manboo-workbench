package com.llm.live2d;

/**
 * 启动期策略开关，按 LAUNCHER_KIND 分流。
 * 目前只有 keyguard dismissal 一项（MainActivity.onResume 调用）：
 * U3 电台桌面无密码锁屏唤醒即散；掌机若调会把首个 Surface 延后约十秒；手机非桌面不涉及。
 *
 * ⚠️ 本文件是补提交：d27f935 引用了它但没把它提交进库，导致 main 编译失败。
 * 若同事推了正式版本，以正式版本为准替换。
 */
final class LauncherStartupPolicy {
    private LauncherStartupPolicy() {}

    static boolean shouldRequestKeyguardDismissal(String launcherKind) {
        return "radio".equals(launcherKind);
    }
}
