import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

/**
 * 事务官手机端。只对工作台 8791 说话,工作台在局域网里是 http://<mac>:8791(明文),
 * 所以 androidScheme 用 http + cleartext(与 display-client 同一套做法),否则 WebView 拦混合内容。
 */
const config: CapacitorConfig = {
  appId: 'ai.ben.butler',
  appName: '事务官',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    // 桥接参数里会经过设备令牌,任何构建都不许把 methodData 打进 logcat。
    loggingBehavior: 'none',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#0f0f0f',
      showSpinner: false,
    },
    StatusBar: {
      style: 'dark',
    },
    Keyboard: {
      // 不让 WebView 随键盘缩放,输入框自己贴底(Aiboo 踩过的坑)。
      // **这一项只对 iOS 有效**(插件 README:「Only available on iOS」;安卓那头 setResizeMode 是 unimplemented)。
      // 安卓上 WebView 照样被压矮 —— Capacitor 8 自带的 SystemBars 在键盘弹起时给窗口底边垫上键盘的高度。
      // 弹键盘时球不缩、输入框贴键盘,是网页那一层做的:src/viewport/keyboardViewport.ts(2026-09-24)。
      resize: KeyboardResize.None,
    },
  },
};

export default config;
