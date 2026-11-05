import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 版本号构建时注入(src/version.ts):与 tsdown.config.ts 同源,测试里 PLUGIN_VERSION 才不是 '0'。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * 上游 checkout 在哪。默认 `../../deepseek-harness`(worktree 父目录下那个符号链接,
 * 与 package.json 里 `link:` 的 devDependencies 同一个地方)。
 *
 * 2026-09-25 升级卡 U2 加的口子:那个符号链接是**所有卡共用**的一个工作区,同时还有别的卡
 * 在 0.1.2-rc.1 上跑测试,升级卡不能把它切到新 tag。`DSH_HARNESS_DIR=<某个 checkout>`
 * 让升级卡在自己的 checkout 上跑(同时要把 node_modules/@deepseek-ai/* 指过去,
 * 否则一半解析走别名、一半走 node_modules,等于在两个版本上跑)。
 */
const harnessRoot = process.env.DSH_HARNESS_DIR
  ? pathToFileURL(`${process.env.DSH_HARNESS_DIR.replace(/\/*$/, '')}/`)
  : new URL('../../deepseek-harness/', import.meta.url)

export default defineConfig({
  define: { __WORKBENCH_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      // 0.1.2-rc.1:client-runtime 包已拆——defineStore 在 store,SlotRegistry 在 ui-renderer。
      // 指向 src 而非 lib:lib/client.js 是 window.__ModuleLoader__ 闭包工厂产物,vitest 直接 import 不了。
      '@deepseek-ai/dsh-client-store': fileURLToPath(new URL(
        'packages/client/store/src/index.ts', harnessRoot,
      )),
      '@deepseek-ai/dsh-client-ui-renderer/client': fileURLToPath(new URL(
        'packages/client/ui-renderer/src/client/index.ts', harnessRoot,
      )),
    },
  },
  test: {
    /**
     * 2026-10-23:不用裸 'jsdom'。Node 26.12.1 自带的 localStorage/sessionStorage
     * 占位属性(未指定 --localstorage-file 时 localStorage 取值 undefined;
     * Node 24.19.0 / 24.22.1 实测无此属性)会挡住 vitest 把 jsdom 的同名实现铺到
     * global,window.localStorage 变成 undefined。包装里先删占位属性再委托给
     * 自带 jsdom 环境,见该文件头。同时全仓禁止裸 @vitest-environment jsdom
     * docblock(它会按文件覆盖本配置、绕过包装),守门见
     * tests/environment-docblock-guard-20261023.test.ts。
     */
    environment: './tests/setup/jsdomEnv.ts',
    /**
     * 2026-09-21:jsdom 29.1.1 会把嵌在子树里、随子树卸载的 `<style>` 的样式表漏在
     * `document.styleSheets` 里,同一文件里用例越多、每次重渲越慢(client-dock 那个文件跑到
     * 第 90 条之后一条要 10~20 秒,超时假红)。每条用例前后清一次孤儿表,根因与取舍见该文件头。
     */
    /**
     * 2026-10-21:jsdom 用例的页面默认装着起步层(运营同学那六格,从 `user-layer/起步/` 经加载口装),
     * 见该文件头。
     */
    setupFiles: ['./tests/setup/jsdomStyleSheetLeak.ts', './tests/setup/starterLayer.ts'],
    /**
     * 2026-09-02:99 个文件并行跑 jsdom,而这台机器同时还跑着 DSH、Codex 会话与展示台
     * 构建——真机实测同一份代码连跑三次是「4 挂 / 全过 / 全过」,挂的全是 `render` +
     * `findBy*` 这类**根本没有定时逻辑**的用例:不是逻辑错,是 CPU 被饿死后 5 秒的默认
     * 超时不够用。放宽到 15 秒。
     *
     * 这不会遮住真 bug:真坏掉的用例是**断言失败**(立即报错)而不是超时;死循环/永不
     * resolve 那类问题 15 秒照样超时报出来,只是晚 10 秒。
     */
    testTimeout: 15_000,
    /**
     * 并发上限(同日同因):这台机器 8 核,但 DSH、Codex 会话、展示台构建常年占掉 2~3 核,
     * vitest 默认开满 worker、每个都带一份 jsdom,反而互相饿死——实测 environment(jsdom
     * 启动)一项就占 240 秒。压到 4 个 worker 后总耗时不升反降,抖动也停了。
     * 这是给**这台开发机**定的值(唯一用户是 Ben,不为假想的 CI 留扩展点)。
     */
    maxWorkers: 4,
    /**
     * 2026-10-24:隔离验收实例的临时 HOME 落在 dev/collab-a-acceptance 下各 run 目录的
     * instance/ 里(克隆来的 runtime 有散装的 *.test.mjs,内容与本包无关),vitest 默认
     * 收集会扫到它们、以「No test suite found / 数据不对」把一批文件染红(用例数 0 错)。
     * 证据文件(evidence.json/report.md)在 run 目录根、不含测试,不受影响;instance/ 已
     * 在 .gitignore,但本机整包跑时仍要排掉。
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'dev/collab-a-acceptance/run-*/**'],
  },
})
