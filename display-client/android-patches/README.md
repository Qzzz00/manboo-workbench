# android-patches

`android/` 整个目录被 `.gitignore` 忽略（Capacitor 生成目录），因此项目里的**自定义原生文件不入库**。
本目录保存这些原生改动的权威副本，换机/重新 `npx cap add android` 后需手动拷回 `android/app/src/main/java/...` 再出包。

## 文件

### `com/llm/live2d/CommuteAudioService.kt`（通勤播客锁屏续播，新增）
原生**前台媒体 Service**：两个 ExoPlayer——`voicePlayer` 无缝顺播口播段列表（gapless），
`bedPlayer` 低音量(0.22)循环音乐床。生命周期独立于屏保 `Live2DDreamService`，**锁屏/灭屏/拆 WebView 后音频继续**，
并通过 `MediaSession` + `MediaStyle` 通知提供锁屏媒体控制。控制走 `onStartCommand`（主线程操作 ExoPlayer），
播放状态以 companion `@Volatile` 快照对外（`stateJson()`），供 `ScreensaverBridge.commuteStateJson()` 同步读。

> 起因：通勤 DJ 原靠屏保 WebView 内 JS 串行驱动逐段口播，但锁屏会终止 dream
> （`onDreamingStopped→pauseTimers()` 冻结全部 JS；`onDetachedFromWindow→WebView.destroy()`），
> 任何 JS 兜底都救不了。故把播放搬到独立前台 Service。

需要 `AndroidManifest.xml` 与 `app/build.gradle` 的配套改动（见下文「Manifest / Gradle 增量」）。

> ⚠️ 通勤 DJ 跑在**主 App** WebView（`useDjMode`→`useDj(..., 'commute')`），**不是**屏保 DreamService
> （屏保固定 `mode='focus'`）。主 App 用 Capacitor 插件桥（`window.AibooNative` 只在屏保注入，主 App 没有），
> 故通勤音频控制挂在 **DjState 这个 Capacitor 插件**上，而不是 `ScreensaverBridge`。

### `com/llm/live2d/DjStatePlugin.java`
主 App 的 Capacitor 插件（`name = "DjState"`，已在 `MainActivity.registerPlugin(DjStatePlugin.class)` 注册）。

- `setDjMode(...)`：上报 DJ 模式状态到 `ScreensaverPrefs`，供充电屏保联动。
- `getDeviceLocation()`：用 `LocationManager` 取设备最近已知坐标（lat/lon），供 **DJ 口播跟随本地天气**。
  城市名由 JS 侧（`serverConfig.resolveDeviceCity` → BigDataCloud 反查）解析。依赖 `ACCESS_COARSE_LOCATION` 权限。
- **`commuteStart / commutePause / commuteResume / commuteStop / commuteSeekIndex / commuteState`（通勤锁屏续播，新增）**：
  把口播列表 + 床直链交给 `CommuteAudioService` 原生播放，控制以 `Intent` 投递到 Service；
  `commuteState` 返回 `CommuteAudioService.stateJson()`。JS 侧封装在 `src/lib/djModeBridge.ts`。

## 拷回位置
```
android-patches/com/llm/live2d/DjStatePlugin.java
  → android/app/src/main/java/com/llm/live2d/DjStatePlugin.java
android-patches/com/llm/live2d/CommuteAudioService.kt
  → android/app/src/main/java/com/llm/live2d/CommuteAudioService.kt
```

## Manifest / Gradle 增量（通勤锁屏续播，需手改，无整文件镜像）

`app/build.gradle` — `dependencies {}` 加 media3：
```gradle
implementation "androidx.media3:media3-exoplayer:1.4.1"
implementation "androidx.media3:media3-session:1.4.1"
```

`AndroidManifest.xml`：
- `<application>` 加 `android:usesCleartextTraffic="true"`（ExoPlayer 走 http 后端直链需放行；与 `capacitor.config.ts` 的 `cleartext:true` 一致）
- 新增权限：`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`
- `<application>` 内声明 Service：
```xml
<service
    android:name=".CommuteAudioService"
    android:exported="false"
    android:foregroundServiceType="mediaPlayback" />
```

## 调用链（口播定位）
```
DJ 口播 (djClient.requestSpeak)
  → serverConfig.resolveDeviceCity()
      ├─ 屏保: window.AibooNative.getLocationJson()      (ScreensaverBridge.kt)
      └─ 主 App: DjState.getDeviceLocation()             (本文件)  → BigDataCloud 反查城市
  → GET /api/dj/intro?city=...  → weatherSvc.getWeather({ city })
```
