// @vitest-environment node
/**
 * 守门:**上游自己带的入口不许从我们这一层的缝里露出来**(2026-09-25 升到 0.1.7-rc.2,卡 U2;
 * 评估第二节 2.3「要防的」;三层清单第零节「占位盘查」那一条)。
 *
 * 这一份不渲染上游的界面(那要把整个 DSH 客户端跑起来),它守的是**清单本身是真的**:
 *
 * 1. `src/upstreamEntries.ts` 里每一行的 id,在上游 web 组合里真的有 —— profile patch 是「按 id 覆盖」,
 *    id 打错一个字,那一行就变成**新加一个没人认识的插件行**,终端照样开着,而界面上一切正常。
 *    这是最容易漏、最难在界面上看出来的一种错。
 * 2. 每一行记的「上游默认开不开」跟上游组合对得上 —— 上游哪天把 `ui-schedule` 的 `disabled` 去掉,
 *    我们这张表就过期了;红在这里,而不是红在用户的侧栏上。
 * 3. **`shell.overlay` 这个席位上,上游的占位者还是我们记下的那几个** —— 这是我们自己的席位:
 *    我们的整屏挂在这儿,上游的快捷键参考页、账号平台页也挂在这儿,按一下就画在工作台上面。
 *    上游再加一个,这里当场红,那时要么 patch 里也关掉它,要么接受它盖上来。
 * 4. Agent Team 在 web 组合里一行都没有(我们不装,所以没有要关的东西)。
 *
 * 上游 checkout 在哪:默认 worktree 父目录那个共用符号链接,升级卡用 `DSH_HARNESS_DIR` 指到自己的
 * checkout(共用那份同时还有别的卡在旧版上跑,不能切 tag)。同 `vitest.config.ts` 的口子。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STYLE } from '../src/client/style.ts'
import { renderProfilePatch } from '../src/server/setup/install.ts'
import { ROWS_OFF_FOR_USERS, UPSTREAM_WEB_ENTRIES } from '../src/upstreamEntries.ts'

const harnessDir = process.env.DSH_HARNESS_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deepseek-harness')
const read = (rel: string) => readFileSync(join(harnessDir, rel), 'utf8')

const WEB_PATCH = 'packages/bundle/web-app/cordis.patch.yml'
const BASE_PATCH = 'packages/bundle/base/cordis.patch.yml'
const SLOT_CATALOG = 'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts'

/**
 * 组合文件里的行:`- id: X`(可能缩进),到**同缩进的下一行**之前算它的正文。
 * 不引 yaml 依赖:只要认出 id 与「正文里有没有 disabled:」这两件事。
 */
function rows(text: string): Map<string, { readonly body: string }> {
  const out = new Map<string, { body: string }>()
  const heads = [...text.matchAll(/^([ \t]*)- id: (\S+)[ \t]*$/gm)]
  for (const [i, head] of heads.entries()) {
    const id = head[2]!
    const start = head.index + head[0].length
    const end = heads[i + 1]?.index ?? text.length
    out.set(id, { body: text.slice(start, end) })
  }
  return out
}

const webRows = rows(read(WEB_PATCH))
const baseRows = rows(read(BASE_PATCH))
const rowOf = (id: string) => webRows.get(id) ?? baseRows.get(id)

/** 上游那一行现在的默认:写了 `disabled: true` 是 off,写了表达式是 conditional,没写是 on。 */
function upstreamDefaultOf(id: string): 'on' | 'off' | 'conditional' | 'missing' {
  const row = rowOf(id)
  if (row === undefined) return 'missing'
  const disabled = /^[ \t]*disabled:[ \t]*(.*)$/m.exec(row.body)
  if (disabled === null) return 'on'
  return disabled[1]!.trim() === 'true' ? 'off' : 'conditional'
}

/** slot-catalog 里某个席位的 `occupants` 清单(上游自己生成、自己维护的那一份)。 */
function occupantsOf(key: string): string[] {
  const catalog = read(SLOT_CATALOG)
  const at = catalog.indexOf(`key: '${key}',`)
  expect(at, `slot-catalog 里找不到席位 ${key}`).toBeGreaterThan(0)
  const block = catalog.slice(at)
  const list = /occupants: \[([\s\S]*?)\],/.exec(block)
  expect(list, `席位 ${key} 没有 occupants 清单`).not.toBeNull()
  // 清单是 TypeScript 源码里的单引号字符串,里面的 id 用 \' 转义,所以要认转义再还原。
  return [...list![1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map(m => m[1]!.replace(/\\(.)/g, '$1'))
    .sort()
}

describe('上游入口盘查(清单对着 0.1.7-rc.2 的真组合自检)', () => {
  it('★表里每一行的 id 在上游组合里真的存在(patch 按 id 覆盖,打错字就等于没关)', () => {
    for (const entry of UPSTREAM_WEB_ENTRIES) {
      expect(upstreamDefaultOf(entry.id), `组合里没有 id: ${entry.id}`).not.toBe('missing')
    }
  })

  it('★表里记的「上游默认开不开」跟上游组合对得上(上游翻了默认值就红)', () => {
    for (const entry of UPSTREAM_WEB_ENTRIES) {
      expect(upstreamDefaultOf(entry.id), entry.id).toBe(entry.upstreamDefault)
    }
  })

  /**
   * 决策记录 2026-09-26 凌晨「关闭清单再定」拍定的五行(U1 的四条 + U2 的 `ui-shortcuts`,
   * 卡 U4 合并时并成这一份)。`install.ts` 的 `PROFILE_DISABLE_BLOCK` 照这个顺序渲染,
   * 那一头由 `tests/setup-install.test.ts` 钉着「一个不多一个不少」。
   */
  it('★要 patch 关掉的是这五行:终端两半 + 快捷键参考页 + 插件管理页 + 账号页', () => {
    expect([...ROWS_OFF_FOR_USERS]).toEqual([
      'ui-sidebar-terminal', 'terminal-controller', 'ui-shortcuts', 'ui-plugin-manager', 'ui-settings-account',
    ])
    // 只关界面那一行:`shortcuts` 是命令注册表,ui-settings-general 用它注册「打开设置」,不能关。
    expect(ROWS_OFF_FOR_USERS).not.toContain('shortcuts')
    expect(upstreamDefaultOf('shortcuts')).toBe('on')
    // 插件管理页关了,只读那张清单页留着 —— 两个 id 前缀一样,别连坐。
    expect(ROWS_OFF_FOR_USERS).not.toContain('ui-settings-plugin-inventory')
    expect(upstreamDefaultOf('ui-settings-plugin-inventory')).toBe('on')
  })

  /**
   * ★ 这一条是 2026-09-26 卡 U4 灰度撞出来的那个 bug 的守门。
   *
   * cookie 寿命那一行原来写成 `- id: client-connection`(包名去前缀),而组合里的 id 是
   * `connection`。补丁层按 id 找不到只 `warn` 一句就跳过,**进程照样起、界面一切正常**,
   * 于是 `cookieMaxAgeDays: 3650` 从 0.1.2 起一直没生效过 —— 灰度 `--dump-config` 里
   * 那一行的 config 只有 `trustedHosts`。
   *
   * 所以守的不只是关插件那五行:**patch 里每一个 id 都要在上游真组合里存在**。
   * 唯一的例外是我们自己 insert 进去的 `ben-workbench`(它本来就不在上游组合里)。
   */
  it('★profile patch 里每个 id 都在上游真组合里存在(写错 id 会被静默跳过,界面上看不出来)', () => {
    const patch = renderProfilePatch(undefined)
    const ids = [...patch.matchAll(/^- id: (\S+)$/gm)].map(m => m[1]!)
    expect(ids.length, 'patch 里一个 id 都没读到 —— 渲染写法变了?').toBeGreaterThan(0)
    for (const id of ids) {
      if (id === 'ben-workbench') continue // 我们自己 insert 的那一行,上游组合里当然没有。
      expect(upstreamDefaultOf(id), `patch 写了 id: ${id},但上游组合里没有这一行`).not.toBe('missing')
    }
    // cookie 那一行按名字再钉一次:它是这条守门的由来。
    expect(ids).toContain('connection')
    expect(ids).not.toContain('client-connection')
  })

  it('★升级时把老机器上那个错 id 改对(不能只当「已经补过了」放着)', () => {
    // 老机器上的样子:错 id + 已经有 cookieMaxAgeDays 这个词。
    const old = '# 工作台登录台生成(可以继续往下加别的补丁)。\n'
      + '\n- insert:\n    - id: ben-workbench\n      name: \'@ben/dsh-workbench\'\n'
      + '\n- id: client-connection\n  config:\n    trustedHosts: !!js ctx.webRuntime.trustedHosts\n    cookieMaxAgeDays: 3650\n'
    const fixed = renderProfilePatch(old)
    expect(fixed).toContain('- id: connection\n')
    expect(fixed).not.toContain('- id: client-connection')
    // 他自己调过的天数不动(修的是「这一行没被认出来」,不是他的选择)。
    const custom = renderProfilePatch(old.replace('cookieMaxAgeDays: 3650', 'cookieMaxAgeDays: 90'))
    expect(custom).toContain('cookieMaxAgeDays: 90')
    expect(custom).not.toContain('cookieMaxAgeDays: 3650')
  })

  it('★表里只剩一条 undecided —— 别的都已经定了给用户开还是关', () => {
    const undecided = UPSTREAM_WEB_ENTRIES.filter(e => e.forUsers === 'undecided').map(e => e.id)
    // `ui-schedule` 是唯一留着的「灰度里逐项定」:上游 web 组合自己就关着,我们一行都不加,
    // 所以它定不定都不影响用户看到什么(决策记录:定时任务另开卡当事务官自用工具接)。
    expect(undecided).toEqual(['ui-schedule'])
  })

  it('★shell.overlay(我们自己的席位)上,上游的占位者还是记下的那几个 —— 多一个就来定怎么办', () => {
    expect(occupantsOf('shell.overlay')).toEqual([
      'client-ui-chat QuotaNoticeHost id \'chat.quota-notice\'',
      'client-ui-schedule ScheduleDeleteToast id \'schedule.delete-toast\'',
      'client-ui-settings-account AccountPlatformHost id \'account.platform-page\'',
      'client-ui-settings-account DesktopOnboardingEntry id \'desktop-onboarding\'',
      'client-ui-shortcuts ShortcutReference id \'shortcuts\'',
      'client-ui-workspace RowActionToast id \'workspace.row-toast\'',
      'client-ui-workspace SessionArchiveConfirmDialog id \'workspace.session-archive\'',
      'client-ui-workspace SessionRenameDialog id \'workspace.session-rename\'',
    ])
  })

  it('★sidebar.footer.action(我们另一个席位)上,上游只有 cordis 那一颗', () => {
    expect(occupantsOf('sidebar.footer.action')).toEqual(['client-ui-cordis CordisPanel id \'cordis-panel\''])
  })

  /**
   * 工作台开着的时候,上游整片界面看不见也点不到 —— 靠的不是藏它,是我们这一层**不透明、铺满、吃掉点击**。
   * 这三条是「不露出来」在渲染层的全部依据(浮层让开之后就是上游的对话页,那是设计如此)。
   * 从真 CSS 文本里读,跟 `butler-app/tests/phoneKeyboardFit.test.tsx` 同一个路子。
   */
  it('★我们这一层铺满整屏、不透明、吃掉点击 —— 上游在下面看不见也点不到', () => {
    const rule = /\n\.ben-wb\{([^}]*)\}/.exec(STYLE)
    expect(rule, 'style.ts 里找不到 .ben-wb 的根规则').not.toBeNull()
    const decls = rule![1]!
    expect(decls).toContain('position:absolute')
    expect(decls).toContain('inset:0')
    expect(decls).toContain('pointer-events:auto')
    // 背景必须是实色令牌:换成 rgba()/transparent 一类,上游的侧栏就会从我们身下透出来。
    const background = /background:([^;]+)/.exec(decls)
    expect(background, '.ben-wb 没有背景色').not.toBeNull()
    expect(background![1]!.trim()).toBe('var(--dsw-alias-bg-base)')
  })

  it('Agent Team 不在默认 web 组合里(我们不装,没有要关的东西)', () => {
    expect(read(WEB_PATCH).toLowerCase()).not.toContain('team')
    expect(read(BASE_PATCH).toLowerCase()).not.toContain('team')
  })
})
