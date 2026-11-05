import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * docblock 的 `@vitest-environment jsdom` 会**按文件覆盖** vitest.config.ts 里的
 * environment(实测见 vitest 4.1.10 源码 `detectCodeBlock`:pragma 值优先于 config),
 * 从而绕过 ./tests/setup/jsdomEnv.ts 的包装 —— Node 26 自带的 localStorage 占位属性
 * 挡住 jsdom 实现,window.localStorage 变成 undefined,存储路径静默降级
 * (2026-10-23 独立验收退修:73 个带 docblock 的用例文件就是这么绕过包装的)。
 *
 * 本仓的约定是:environment 只在 vitest.config.ts 一处决定(默认 jsdom,走包装;
 * 服务端用例用 docblock 显式声明 node 退出 jsdom)。docblock 里不允许再出现裸 jsdom。
 * 注意 vitest 的 pragma 正则只收 `[\w-]+`,写不成路径,所以「docblock 指向包装」
 * 这条路在这个版本上不存在,要 docblock 就只能是裸名,干脆禁掉。
 */
// vitest 下 import.meta.url 被改写不可靠,cwd 即 config root(workbench-plugin)。
const TESTS_DIR = join(process.cwd(), 'tests')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)) yield full
  }
}

describe('jsdom 环境只从 vitest.config.ts 的包装进(禁裸 docblock)', () => {
  it('任何用例文件都不得带 @vitest-environment jsdom docblock', () => {
    const offenders: string[] = []
    for (const file of walk(TESTS_DIR)) {
      if (file.endsWith('/environment-docblock-guard-20261023.test.ts')) continue
      const code = readFileSync(file, 'utf-8')
      if (/@(?:vitest|jest)-environment\s+jsdom\b/.test(code)) {
        offenders.push(file.replace(`${TESTS_DIR}/`, ''))
      }
    }
    expect(offenders).toEqual([])
  })
})
