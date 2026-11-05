/**
 * 应用名（中文/英文/别名）→ Android 包名。语音"打开微信"经 LLM 判成 open_app:微信，执行侧查此表。
 * 未收录返回 null，调用侧回落打开"更多应用"抽屉让用户手选。纯函数、大小写/空白不敏感。
 * ★包名是常见默认值；个别 ROM(如 careai/MTK 定制系统应用)包名可能不同，真机 launchApp 失败即回落抽屉。
 */
const APP_PACKAGES: Record<string, string> = {
  // key 一律小写；同一应用多别名各占一行。
  '微信': 'com.tencent.mm', 'wechat': 'com.tencent.mm',
  'qq': 'com.tencent.mobileqq',
  '图库': 'com.android.gallery3d', '相册': 'com.android.gallery3d', 'gallery': 'com.android.gallery3d',
  '日历': 'com.android.calendar', 'calendar': 'com.android.calendar',
  '计算器': 'com.android.calculator2', 'calculator': 'com.android.calculator2',
  '文件': 'com.android.documentsui', '文件管理': 'com.android.documentsui', 'files': 'com.android.documentsui',
  '设置': 'com.android.settings', 'settings': 'com.android.settings',
  '相机': 'com.android.camera2', 'camera': 'com.android.camera2',
  '时钟': 'com.android.deskclock', 'clock': 'com.android.deskclock',
  '浏览器': 'com.android.browser', 'browser': 'com.android.browser',
};

export function resolveAppPackage(name: string): string | null {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return APP_PACKAGES[key] ?? null;
}
