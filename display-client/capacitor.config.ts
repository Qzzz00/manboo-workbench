import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.llm.live2d',
  appName: 'LLM Live2D',
  webDir: 'dist',

  server: {
    androidScheme: 'http',
    cleartext: true,
  },

  android: {
    allowMixedContent: true,
    // Overlay bridge options 含 Intent-only 认证与 ROM 上下文；debug 包也不允许 Capacitor 把 methodData 打进 logcat。
    loggingBehavior: 'none',
  },

  ios: {
    scheme: 'LLM Live2D',
  },

  plugins: {
    SplashScreen: {
      // 底色改成与 app 加载态一致的深灰（原 #1a1a2e 蓝会让 U3 上「KeenPlus→蓝 loading→app」像两段）；
      // launchShowDuration 仍留 2000 作主 App 兜底，U3 的 RadioApp 挂载后主动 SplashScreen.hide() 提前收（见 RadioApp）。
      launchShowDuration: 2000,
      backgroundColor: '#262626',
      showSpinner: false,
    },
    StatusBar: {
      style: 'dark',
    },
    Keyboard: {
      // 关键：禁止 WebView 随键盘自动缩放，否则会和 composer 的 translateY 叠加导致输入框飞到顶部
      resize: KeyboardResize.None,
    },
  },
};

export default config;
