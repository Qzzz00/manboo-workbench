// @vitest-environment node
/**
 * 装机形态测试:**登录台写进 profile 补丁层的每一行,装在机器上的那份真 dsh 都认**(2026-09-26)。
 *
 * ## 为什么非要这一份
 *
 * profile patch 是「按 id 覆盖」。id 写错一个字,上游 `applyEntryPatches` 只
 * `warn("patch: entry %C not found")` 然后**整行跳过** —— 进程照样起、界面一切正常。
 * cookie 寿命那一行就是这样:写的是 `client-connection`(包名去前缀),组合里的 id 是 `connection`,
 * 于是 `cookieMaxAgeDays: 3650` 从 0.1.2 活到 0.1.7 都没生效过,「引导一次长期有效」其实一直是 30 天。
 * 关插件那五行是同一类:id 打错,终端照样开着而界面上一切正常。
 *
 * 已有的守门 `client-upstream-seats.test.ts` 拿 id 去对上游 **checkout** 的 yml,那是一道;
 * 这一份对的是**装在机器上的那份运行时真怎么合**:把 `renderProfilePatch` 写出来的那份放进
 * 一台 scratch 机器,起真的 `dsh web --dump-config`,断言 stderr 里对**每一个 id** 都没有
 * `entry "…" not found` / `name mismatch`,再到合成结果里核那一行**真的带上了我们写的值**。
 *
 * 带两条**对照**(否则上面那句「一句都不抱怨」哪天会变成永远绿的空话):
 * - 不修的老文件(错 id)真 dsh 就是那样沉默失效的 —— 抱怨一句、cookie 寿命不在配置里;
 * - 故意放一个不存在的 id,dsh 真的抱怨了 —— 上游改了告警措辞这里当场红。
 *
 * ## 哪几样是真的 / 假的
 *
 * - 真:运行时(符号链接指向装好的 0.1.7,只读)、`renderProfilePatch` / `profilePackageJson`、dsh 本身。
 * - 假的一样都没有 —— 没有令牌、没有网络;`--dump-config` 不 listen、不 mount。
 * - 生产一个字节不碰:`DSH_HOME` 是 mkdtemp 出来的;`launchctl` 一次都不跑。
 *
 * 没有那份运行时时整份跳过并说清原因(`tests/setup/realDshRuntime.ts`)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROFILE_COOKIE_ROW_ID, PROFILE_COOKIE_WRONG_ROW_ID, profilePackageJson, renderProfilePatch,
} from '../src/server/setup/install.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { ROWS_OFF_FOR_USERS } from '../src/upstreamEntries.ts'
import { READY, RUNTIME, WHY_SKIPPED, configKeysOf, dumpConfig, dumpedRow } from './setup/realDshRuntime.ts'

const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-profile-')
const boxes: string[] = []
afterEach(() => {
  // 0904 家目录被删事故之后的纪律:递归删除只许落在本用例前缀下的那个 mkdtemp 沙箱里。
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

/** 摆出一台机器:`runtime` 指着真运行时(只读),profile 用真的登录台函数建,补丁层是传进来的那份。 */
function machine(patch: string) {
  const home = mkdtempSync(BOX_PREFIX)
  boxes.push(home)
  const paths = setupPaths({ home })
  mkdirSync(`${paths.dshHome}/workbench`, { recursive: true })
  symlinkSync(RUNTIME, paths.runtimeDir)
  mkdirSync(paths.profileDir, { recursive: true })
  writeFileSync(paths.profilePackageJson, profilePackageJson())
  writeFileSync(paths.profilePatchYml, patch)
  return { home, paths, dump: () => dumpConfig(paths.dshHome, paths.runtimeDir) }
}

/** 一份 patch 里写了哪些 id(含 insert 里那一行)。 */
function idsIn(patch: string): string[] {
  return [...patch.matchAll(/^[ \t]*- id: (\S+)[ \t]*$/gm)].map(m => m[1]!)
}

/** dsh 在 stderr 里对**我们这份文件**的抱怨(每一句都带文件路径与 `patch` 字样)。 */
function complaintsAbout(warnings: string, patchFile: string): string[] {
  return warnings.split('\n').filter(line => line.includes(patchFile) && line.includes('patch'))
}

/**
 * 0.1.2 时代登录台建出来的那份(`dsh-profile-patch.test.ts` 里 `OURS` 的前半),
 * cookie 那一行的 id 是错的 —— 每一台 2026-09-26 之前装的机器上都是这个样子。
 */
const OLD_MACHINE = `# 工作台登录台生成(可以继续往下加别的补丁)。

# 桌面工作台插件(desktop-workbench/workbench-plugin)。
- insert:
    - id: ben-workbench
      name: '@ben/dsh-workbench'

# DSH 0.1.2-rc.1 起网页要 token 或签名 cookie 才能开;把 cookie 寿命拉长,引导一次长期有效。
# 补丁会整体替换该行的 config,所以 trustedHosts 表达式要照抄 bundle 里的原文。
- id: ${PROFILE_COOKIE_WRONG_ROW_ID}
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    cookieMaxAgeDays: 3650
`

describe.skipIf(!READY)('0.1.7 形态:登录台写的补丁层,真 dsh 逐行都认', () => {
  it('★新机器:写出来的每一行真 dsh 一句都不抱怨;cookie 寿命与关掉的五行都真进了配置', () => {
    const patch = renderProfilePatch(undefined)
    const box = machine(patch)
    const { config, warnings } = box.dump()

    // 合的时候确实读了我们这份补丁(上游会在段头写清楚它被谁打过补丁)—— 不然下面全是空话。
    expect(config).toContain(`patched by ${box.paths.profilePatchYml}`)

    // ★ 逐行:每一个 id 都没被 dsh 认成「不存在」或「名字对不上」,而且真出现在合成结果里。
    const ids = idsIn(patch)
    expect(ids.length, 'patch 里一个 id 都没读到 —— 渲染写法变了?').toBeGreaterThan(0)
    for (const id of ids) {
      expect(warnings, id).not.toContain(`entry "${id}" not found`)
      expect(warnings, id).not.toContain(`name mismatch for "${id}"`)
      expect(dumpedRow(config, id), `合成结果里没有 - id: ${id}`).toBeDefined()
    }
    // 再钉死:对我们这份文件,dsh 一句抱怨都没有(不只是上面列出来的那两种措辞)。
    expect(complaintsAbout(warnings, box.paths.profilePatchYml)).toEqual([])

    // cookie 寿命:那一行的 config 里真有我们写的天数,而且照抄的表达式还在(补丁整体替换 config)。
    const connection = dumpedRow(config, PROFILE_COOKIE_ROW_ID)!
    expect(connection).toContain('cookieMaxAgeDays: 3650')
    expect(connection).toContain('trustedHosts: !!js ctx.webRuntime.trustedHosts')

    // 关掉的五行:合成结果里真是 `disabled: true`(灰度时 U4 是手工抄 dump 核的,现在机器核)。
    expect(ROWS_OFF_FOR_USERS.length).toBeGreaterThan(0)
    for (const id of ROWS_OFF_FOR_USERS) {
      expect(dumpedRow(config, id), id).toContain('disabled: true')
    }

    // 我们自己那一行 insert 进去了。
    expect(dumpedRow(config, 'ben-workbench')).toContain('@ben/dsh-workbench')
  })

  /**
   * ★ 补丁会**整体替换**那一行的 config。所以 cookie 那一块照抄的 `trustedHosts` 表达式,
   * 必须仍是**装着的这份上游**写的那个;上游给这一行加了别的 config 键,我们也得跟着抄 ——
   * 不然升级那天我们的补丁会把上游的新配置无声抹掉。这一条对的是装在机器上的运行时,
   * 不是源码 checkout(两边可能不是同一个版本)。
   */
  it('★照抄的 trustedHosts 表达式仍是装着的上游写的那个;上游那一行的 config 键我们一个不少', () => {
    const upstreamWebPatch = readFileSync(join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml'), 'utf8')
    const upstream = dumpedRow(upstreamWebPatch, PROFILE_COOKIE_ROW_ID)
    expect(upstream, `装着的上游 web 组合里没有 - id: ${PROFILE_COOKIE_ROW_ID}`).toBeDefined()
    const ours = dumpedRow(renderProfilePatch(undefined), PROFILE_COOKIE_ROW_ID)!

    const expr = /^[ \t]*trustedHosts:.*$/m.exec(upstream!)
    expect(expr, '上游那一行没有 trustedHosts 了 —— cookie 那一块要重新对着上游抄').not.toBeNull()
    expect(ours).toContain(expr![0].trim())
    for (const key of configKeysOf(upstream!)) {
      expect(configKeysOf(ours), `上游 ${PROFILE_COOKIE_ROW_ID} 的 config 多了 ${key},我们那一块没抄`).toContain(key)
    }
  })

  it('★老机器(0.1.2 时代那份、id 写错):登录台修过之后真 dsh 不再抱怨,cookie 寿命真进了配置', () => {
    const fixed = renderProfilePatch(OLD_MACHINE)
    expect(fixed).not.toContain(`- id: ${PROFILE_COOKIE_WRONG_ROW_ID}`)
    const box = machine(fixed)
    const { config, warnings } = box.dump()

    expect(complaintsAbout(warnings, box.paths.profilePatchYml)).toEqual([])
    for (const id of idsIn(fixed)) {
      expect(warnings, id).not.toContain(`entry "${id}" not found`)
      expect(dumpedRow(config, id), `合成结果里没有 - id: ${id}`).toBeDefined()
    }
    expect(dumpedRow(config, PROFILE_COOKIE_ROW_ID)).toContain('cookieMaxAgeDays: 3650')
    // 升级时顺手补上的关闭五行也在。
    for (const id of ROWS_OFF_FOR_USERS) expect(dumpedRow(config, id), id).toContain('disabled: true')
  })

  it('对照:不修的话真 dsh 就是这么沉默失效的 —— 抱怨一句、cookie 寿命不在配置里、进程照样起', () => {
    const box = machine(OLD_MACHINE)
    const { config, warnings } = box.dump()

    expect(warnings).toContain(`patch: entry "${PROFILE_COOKIE_WRONG_ROW_ID}" not found`)
    const connection = dumpedRow(config, PROFILE_COOKIE_ROW_ID)!
    expect(connection).not.toContain('cookieMaxAgeDays')
    expect(connection).toContain('trustedHosts')
    // 那个错 id 的行在合成结果里根本不存在 —— 不是「多了一行没人认识的」,是被丢掉了。
    expect(dumpedRow(config, PROFILE_COOKIE_WRONG_ROW_ID)).toBeUndefined()
  })

  it('★维护者自己调过天数:id 改对,他的 90 天原样进了配置(修的是「这一行没被认出来」,不是他的选择)', () => {
    const box = machine(renderProfilePatch(OLD_MACHINE.replace('cookieMaxAgeDays: 3650', 'cookieMaxAgeDays: 90')))
    const { config, warnings } = box.dump()
    expect(complaintsAbout(warnings, box.paths.profilePatchYml)).toEqual([])
    const connection = dumpedRow(config, PROFILE_COOKIE_ROW_ID)!
    expect(connection).toContain('cookieMaxAgeDays: 90')
    expect(connection).not.toContain('cookieMaxAgeDays: 3650')
  })

  it('维护者删掉终端那两行(他要用终端):真 dsh 合出来终端就是开着的,别的三行仍关着', () => {
    const edited = renderProfilePatch(undefined)
      .replace('- id: ui-sidebar-terminal\n  disabled: true\n', '')
      .replace('- id: terminal-controller\n  disabled: true\n', '')
    const box = machine(renderProfilePatch(edited))
    const { config, warnings } = box.dump()
    expect(complaintsAbout(warnings, box.paths.profilePatchYml)).toEqual([])
    expect(dumpedRow(config, 'ui-sidebar-terminal')).not.toContain('disabled')
    expect(dumpedRow(config, 'terminal-controller')).not.toContain('disabled')
    for (const id of ROWS_OFF_FOR_USERS.filter(id => id !== 'ui-sidebar-terminal' && id !== 'terminal-controller')) {
      expect(dumpedRow(config, id), id).toContain('disabled: true')
    }
  })

  /**
   * 对照:上面那些「stderr 里没有 not found」靠的是上游告警的措辞。这里故意写一个不存在的 id,
   * 断言 dsh **真的**用那句话抱怨了 —— 上游哪天改了措辞,这条先红,而不是让上面那些悄悄变成空话。
   */
  it('对照:故意写一个不存在的 id,真 dsh 会用那句话抱怨(告警措辞变了这里先红)', () => {
    const bogus = `ui-nope-${process.pid}`
    const box = machine(`${renderProfilePatch(undefined)}\n- id: ${bogus}\n  disabled: true\n`)
    const { config, warnings } = box.dump()
    expect(warnings).toContain(`patch: entry "${bogus}" not found`)
    expect(complaintsAbout(warnings, box.paths.profilePatchYml)).toHaveLength(1)
    expect(dumpedRow(config, bogus)).toBeUndefined()
    // 别的行不受牵连:一行坏了 dsh 只跳过那一行。
    expect(dumpedRow(config, PROFILE_COOKIE_ROW_ID)).toContain('cookieMaxAgeDays: 3650')
  })
})

describe.skipIf(READY)('跳过说明', () => {
  it('没有那份真运行时,这一份验不了(验的正是"真 DSH 认不认")', () => {
    console.log(`[装机形态·补丁层] 跳过:${WHY_SKIPPED}`)
    expect(READY).toBe(false)
  })
})
