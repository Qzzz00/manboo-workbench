import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      /**
       * 工作台那半边「球此刻是什么样」那个纯函数(2026-10-04,卡「球的颜色一处算」)——
       * **只给用例**(`tests/orbOneTruthParity.test.ts`):同一份 /state 喂给两端的函数,断言球色相同。
       *
       * 为什么走别名而不是直接写相对路径:插件那半边照 ES2024 写(`Object.hasOwn`、`String.replaceAll`),
       * 手机这边 `lib` 是 ES2020(它跑在 Android WebView 里 —— 放宽 lib 等于允许自己用上 WebView 没有的 API)。
       * 静态相对 import 会把插件那几个文件拖进这边的 tsc 程序、整片判红;走一个 tsc 认不得的标识 +
       * `tests/orb-cell-module.d.ts` 里那一行环境声明,**运行时跑的是真代码,类型只认那一行**。
       * 产品代码照旧互不 import(顶层子目录各自独立)。
       */
      '#orb-cell': fileURLToPath(new URL('../workbench-plugin/src/orbCell.ts', import.meta.url)),
      /**
       * ★ 同上,「答案往哪送」那个纯函数(2026-10-04,卡 `claude/answer-comes-to-her`)——
       * **只给用例**(`tests/answerComesToHerParity.test.ts`):同一份夹具喂给两端,
       * 断言「摆哪一条回答」「摆哪几张刚办完」两端一字不差。理由与上面那一条逐字相同。
       */
      '#answer-cell': fileURLToPath(new URL('../workbench-plugin/src/answerCell.ts', import.meta.url)),
      // 与上述跨工程测试同理：运行真实 core，手机 tsc 只读测试门面。
      '#collab-real-core': fileURLToPath(new URL('./dev/collab-page/realCore.ts', import.meta.url)),
      '#qa-core': fileURLToPath(new URL('../workbench-plugin/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
