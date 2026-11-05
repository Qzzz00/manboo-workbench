# butler-app · 事务官手机端

Capacitor 8 + React 19 + Vite 6,包名 `ai.ben.butler`。只对工作台 8791 说话(设备令牌),不连 Aiboo 云端。
交接与出包步骤:`docs/交接-0914-butler-app.md`。

```bash
pnpm install
pnpm -C ../display-client install     # 横屏展示台页面从 display-client 构建,只做一次
pnpm test                              # vitest
pnpm build                             # tsc + 构建展示台页面到 public/display/ + vite build
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
pnpm android:debug                     # → android/app/build/outputs/apk/debug/app-debug.apk
```

浏览器联调:`node scripts/mock-workbench.mjs --voice`(假工作台,端口 8795,配对码 123456)+ `pnpm dev`,
打开 `http://localhost:4180/#workbench://pair?host=127.0.0.1&port=8795&code=123456`。
