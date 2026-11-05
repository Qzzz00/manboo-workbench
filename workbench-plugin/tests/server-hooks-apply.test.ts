// @vitest-environment node
/**
 * 钩子由工作台代写(2026-09-17 Ben 拍板:放开护栏,只写自己的那几条、写前备份、能一键撤回)。
 *
 * **这一份用例是那条护栏的替代品。** 护栏原来的说法是「程序不写 ~/.claude/settings.json」;
 * 现在程序要写了,于是"它只写自己的那几条、写坏之前先留一份、撤得干净"这三件事必须有东西钉着。
 *
 * 全部在 `mkdtemp` 出来的临时目录里跑 —— **一个字节都不会碰真实的 ~/.claude / ~/.codex**
 * (2026-09-04 家目录被删事故之后的纪律:写盘的用例只在沙箱里验)。
 */
import { mkdtempSync, readFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import {
  WB_HOOKS_BACKUP_TAG,
  wbHooksApply,
  wbHooksBackupPath,
  wbHooksDetectIndent,
  wbHooksMergeInto,
  wbHooksRemoveFrom,
  wbHooksRestartHint,
  wbHooksRevert,
} from '../src/server/hooksApply.ts'
import { CODEX_TRUST_HOW } from '../src/server/codexHookTrust.ts'

/** 钩子脚本的固定位置(卡 R):命令只指这里。 */
const HOOKS = '/Users/someone/.dsh/workbench/hooks'
const OURS_CLAUDE = `${HOOKS}/agent-hook.sh claude`
const OURS_CODEX = `${HOOKS}/agent-hook.sh codex`
const OURS_STATUSLINE = `${HOOKS}/claude-statusline.sh`
const OLD_REPO = '/Users/someone/旧位置/desktop-workbench'
/** 维护者那台机器上现有条目指着的地方(卡 R 要平滑换掉的就是它们)。 */
const BEN_REPO = '/Users/example/Documents/GitHub/desktop-workbench'

function parse(text: string): any {
  return JSON.parse(text)
}

/** 一棵 hooks 里所有命令的全文(不管嵌在哪一层)。 */
function commands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => commands(item))
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const self = typeof record.command === 'string' ? [record.command] : []
  return [...self, ...Object.entries(record).filter(([key]) => key !== 'command').flatMap(([, child]) => commands(child))]
}

describe('合并:只写工作台自己的那几条', () => {
  it('文件还不存在(或空文件)→ 四条 hook + statusLine,replaced 是 0', () => {
    for (const before of [undefined, '', '   \n']) {
      const merged = wbHooksMergeInto(before, 'claude', HOOKS)
      expect(merged.ok).toBe(true)
      if (!merged.ok) return
      const root = parse(merged.result.text)
      expect(Object.keys(root.hooks)).toEqual(['Notification', 'Stop', 'UserPromptSubmit', 'SessionEnd'])
      expect(root.hooks.Stop[0].hooks[0].command).toBe(OURS_CLAUDE)
      expect(root.statusLine.command).toBe(OURS_STATUSLINE)
      expect(merged.result.added).toBe(4)
      expect(merged.result.replaced).toBe(0)
      expect(merged.result.statusLine).toBe('added')
    }
  })

  it('Codex 是三条、没有 statusLine(它没有 Notification,不替它假造)', () => {
    const merged = wbHooksMergeInto(undefined, 'codex', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const root = parse(merged.result.text)
    expect(Object.keys(root.hooks)).toEqual(['Stop', 'UserPromptSubmit', 'SessionEnd'])
    expect(root.statusLine).toBeUndefined()
    expect(merged.result.added).toBe(3)
    expect(merged.result.statusLine).toBe('none')
  })

  it('★他自己的设置一个字不动:权限、模型、别的 hook 全在,顺序也没变', () => {
    const before = JSON.stringify({
      permissions: { allow: ['Bash(git:*)'] },
      model: 'opus',
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/opt/他自己的/notify.sh' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: '/opt/他自己的/guard.sh' }] }],
      },
      env: { FOO: '1' },
    }, null, 2)
    const merged = wbHooksMergeInto(before, 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const root = parse(merged.result.text)
    // 顶层键顺序原样(JSON.parse/stringify 保插入顺序),我们只在末尾补 statusLine。
    expect(Object.keys(root)).toEqual(['permissions', 'model', 'hooks', 'env', 'statusLine'])
    expect(root.permissions.allow).toEqual(['Bash(git:*)'])
    expect(root.env).toEqual({ FOO: '1' })
    // 他的 Stop 还在,而且还在最前面;我们的追加在后面。
    expect(root.hooks.Stop[0].matcher).toBe('*')
    expect(root.hooks.Stop[0].hooks[0].command).toBe('/opt/他自己的/notify.sh')
    expect(root.hooks.Stop[1].hooks[0].command).toBe(OURS_CLAUDE)
    // 我们压根不认识的事件(PreToolUse)整项不动。
    expect(root.hooks.PreToolUse[0].hooks[0].command).toBe('/opt/他自己的/guard.sh')
    expect(merged.result.replaced).toBe(0)
  })

  it('★headroom 那几条(Codex 侧真有)不动', () => {
    const before = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh stop' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh end' }] }],
      },
    }, null, 2)
    const merged = wbHooksMergeInto(before, 'codex', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const all = commands(parse(merged.result.text).hooks)
    expect(all.filter(command => command.includes('headroom'))).toHaveLength(2)
    expect(all.filter(command => command === OURS_CODEX)).toHaveLength(3)
  })

  it('★幂等:重复接两次不会变成八条', () => {
    const once = wbHooksMergeInto(undefined, 'claude', HOOKS)
    expect(once.ok).toBe(true)
    if (!once.ok) return
    const twice = wbHooksMergeInto(once.result.text, 'claude', HOOKS)
    expect(twice.ok).toBe(true)
    if (!twice.ok) return
    expect(commands(parse(twice.result.text).hooks)).toHaveLength(4)
    expect(twice.result.replaced).toBe(4)
    expect(twice.result.statusLine).toBe('replaced')
    expect(twice.result.text).toBe(once.result.text)
  })

  it('★旧版工作台条目(指着搬家前的仓库)被换掉,不是两条并存', () => {
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `${OLD_REPO}/workbench-plugin/bin/agent-hook.sh claude`, timeout: 5 }] }] },
      statusLine: { type: 'command', command: `${OLD_REPO}/workbench-plugin/bin/claude-statusline.sh` },
    }, null, 2)
    const merged = wbHooksMergeInto(before, 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const all = commands(parse(merged.result.text).hooks)
    expect(all.some(command => command.includes('旧位置'))).toBe(false)
    expect(all.filter(command => command === OURS_CLAUDE)).toHaveLength(4)
    expect(parse(merged.result.text).statusLine.command).toBe(OURS_STATUSLINE)
    expect(merged.result.replaced).toBe(1)
  })

  /**
   * 卡 R(2026-09-25):维护者那台机器上现有的条目指着开发仓库里的 `workbench-plugin/bin/…`。
   * 下次「接上」要**平滑换成新位置**:旧的一条不剩(不并存)、他自己的一个字不动(连顺序都不动)、
   * 状态栏那一条也换过去。
   */
  it('★维护者那台:四条旧条目 + 旧状态栏(指着开发仓库)→ 全换成固定位置,他自己的一个字不动', () => {
    const OLD = `${BEN_REPO}/workbench-plugin/bin/agent-hook.sh claude`
    const beforeRoot = {
      permissions: { allow: ['Bash(git:*)'] },
      model: 'opus',
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: OLD, timeout: 5 }] }],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/opt/他自己的/notify.sh' }] },
          { hooks: [{ type: 'command', command: OLD, timeout: 5 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: OLD, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: OLD, timeout: 5 }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: '/opt/他自己的/guard.sh' }] }],
      },
      statusLine: { type: 'command', command: `${BEN_REPO}/workbench-plugin/bin/claude-statusline.sh` },
      env: { FOO: '1' },
    }
    const before = `${JSON.stringify(beforeRoot, null, 2)}\n`
    const merged = wbHooksMergeInto(before, 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const root = parse(merged.result.text)
    const all = commands(root.hooks)
    // 旧位置一条不剩,新位置正好四条(不是八条)。
    expect(all.some(command => command.includes('workbench-plugin/bin'))).toBe(false)
    expect(all.filter(command => command === OURS_CLAUDE)).toHaveLength(4)
    expect(merged.result.replaced).toBe(4)
    expect(merged.result.added).toBe(4)
    // 状态栏也换过去(旧的那条也是工作台的,不是他自己配的)。
    expect(root.statusLine.command).toBe(OURS_STATUSLINE)
    expect(merged.result.statusLine).toBe('replaced')
    // 他自己的:权限、模型、env、Stop 上那条(还在最前)、PreToolUse,一个字不动。
    expect(root.permissions).toEqual(beforeRoot.permissions)
    expect(root.model).toBe('opus')
    expect(root.env).toEqual({ FOO: '1' })
    expect(root.hooks.Stop[0]).toEqual(beforeRoot.hooks.Stop[0])
    expect(root.hooks.PreToolUse).toEqual(beforeRoot.hooks.PreToolUse)
    // 顶层键的顺序原样。
    expect(Object.keys(root)).toEqual(Object.keys(beforeRoot))

    // 撤回:只摘工作台的(新位置的四条 + 状态栏),他自己的原样留着。
    const back = wbHooksRemoveFrom(merged.result.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const left = parse(back.result.text)
    expect(commands(left.hooks)).toEqual(['/opt/他自己的/notify.sh', '/opt/他自己的/guard.sh'])
    expect(left.statusLine).toBeUndefined()
    expect(back.result.removed).toBe(4)
  })

  it('★撤回也认旧位置:还没换过去的旧条目一样摘得干净', () => {
    const before = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh' }] },
          { hooks: [{ type: 'command', command: `${BEN_REPO}/workbench-plugin/bin/agent-hook.sh codex` }] },
        ],
      },
    }, null, 2)
    const stripped = wbHooksRemoveFrom(before)
    expect(stripped.ok).toBe(true)
    if (!stripped.ok) return
    expect(commands(parse(stripped.result.text).hooks)).toEqual(['/opt/headroom/bin/headroom-hook.sh'])
    expect(stripped.result.removed).toBe(1)
  })

  /**
   * Codex 的「信任」按位置记(`hooks.json:stop:0:0` 这种键,第几组、组里第几条)。
   * 维护者那台 10-21:我们三条排在各事件第 0 组,ai-memory 探针挂在第 1 组。原来的做法是
   * 「先摘掉再追加到末尾」—— 再点一次「接上」,我们就挪到第 1 组(她点过的信任作废),
   * ai-memory 那条挪到第 0 组、撞上我们那条的指纹(变成「已修改」)。所以要**原地换**。
   */
  it('★原地换:别人的条目排在我们后面时,重接一次我们还在原来那一组(Codex 的信任按位置记)', () => {
    const AI_MEMORY = '/opt/ai-memory hook --event stop --agent codex'
    const before = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom init', timeout: 15 }] }],
        Stop: [
          { hooks: [{ type: 'command', command: OURS_CODEX, timeout: 5 }] },
          { matcher: '', hooks: [{ type: 'command', command: AI_MEMORY }] },
        ],
        SessionEnd: [
          { hooks: [{ type: 'command', command: OURS_CODEX, timeout: 5 }] },
          { matcher: '', hooks: [{ type: 'command', command: AI_MEMORY }] },
        ],
      },
    }, null, 2)
    const merged = wbHooksMergeInto(before, 'codex', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const root = parse(merged.result.text)
    expect(root.hooks.Stop.map((group: any) => group.hooks[0].command)).toEqual([OURS_CODEX, AI_MEMORY])
    expect(root.hooks.SessionEnd.map((group: any) => group.hooks[0].command)).toEqual([OURS_CODEX, AI_MEMORY])
    // 原来没有的那一项照旧补在末尾。
    expect(root.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: OURS_CODEX, timeout: 5 }] }])
    expect(Object.keys(root.hooks)).toEqual(['SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit'])
    expect(merged.result.replaced).toBe(2)
    // 再接一次,一个字不变。
    const again = wbHooksMergeInto(merged.result.text, 'codex', HOOKS)
    expect(again.ok && again.result.text).toBe(merged.result.text)
  })

  it('★同一组里混着别人的:我们那条换在原来是第几条就还是第几条,不另起一组', () => {
    const before = JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [
        { type: 'command', command: '/opt/他自己的/a.sh' },
        { type: 'command', command: `${BEN_REPO}/workbench-plugin/bin/agent-hook.sh codex` },
        { type: 'command', command: '/opt/他自己的/b.sh' },
      ] }] },
    }, null, 2)
    const merged = wbHooksMergeInto(before, 'codex', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const stop = parse(merged.result.text).hooks.Stop
    expect(stop).toHaveLength(1)
    expect(stop[0].matcher).toBe('*')
    expect(stop[0].hooks.map((hook: any) => hook.command)).toEqual(['/opt/他自己的/a.sh', OURS_CODEX, '/opt/他自己的/b.sh'])
    expect(merged.result.replaced).toBe(1)
  })

  it('同一个事件下有好几处工作台的旧条目 → 留第一处(换成新的),其余摘掉', () => {
    const before = JSON.stringify({
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: `${OLD_REPO}/workbench-plugin/bin/agent-hook.sh codex` }] },
        { hooks: [{ type: 'command', command: '/opt/他自己的/notify.sh' }] },
        { hooks: [{ type: 'command', command: OURS_CODEX, timeout: 5 }] },
      ] },
    }, null, 2)
    const merged = wbHooksMergeInto(before, 'codex', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(commands(parse(merged.result.text).hooks.Stop)).toEqual([OURS_CODEX, '/opt/他自己的/notify.sh'])
    expect(merged.result.replaced).toBe(2)
  })

  it('★他自己配过状态栏 → 不动它,如实回 kept_user(状态栏只是显示,不值得为它冒险)', () => {
    const before = JSON.stringify({ statusLine: { type: 'command', command: '/opt/他自己的/status.sh' } }, null, 2)
    const merged = wbHooksMergeInto(before, 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(parse(merged.result.text).statusLine.command).toBe('/opt/他自己的/status.sh')
    expect(merged.result.statusLine).toBe('kept_user')
  })

  it('★写坏了的 JSON → 拒绝,一个字都不写', () => {
    const merged = wbHooksMergeInto('{ "hooks": { 少了个括号', 'claude', HOOKS)
    expect(merged.ok).toBe(false)
    if (merged.ok) return
    expect(merged.error).toContain('JSON')
  })

  it('★hooks 是我们没见过的结构(数组)→ 拒绝,不猜', () => {
    const merged = wbHooksMergeInto(JSON.stringify({ hooks: [{ event: 'Stop' }] }), 'codex', HOOKS)
    expect(merged.ok).toBe(false)
  })
})

describe('格式:尽量不把他的文件重排一遍', () => {
  it('四格缩进的文件写回去还是四格;Tab 的还是 Tab', () => {
    const four = JSON.stringify({ model: 'opus' }, null, 4)
    expect(wbHooksDetectIndent(four)).toBe('    ')
    const merged = wbHooksMergeInto(four, 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.result.text).toContain('\n    "model"')

    const tabbed = JSON.stringify({ model: 'opus' }, null, '\t')
    expect(wbHooksDetectIndent(tabbed)).toBe('\t')
    const tabMerged = wbHooksMergeInto(tabbed, 'claude', HOOKS)
    expect(tabMerged.ok && tabMerged.result.text.includes('\n\t"model"')).toBe(true)
  })

  it('原文没有末尾换行就不给它加一个', () => {
    const merged = wbHooksMergeInto('{"model":"opus"}', 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.result.text.endsWith('\n')).toBe(false)
  })
})

describe('撤回:只摘自己的', () => {
  it('★别人的条目一条不少,自己的一条不剩', () => {
    const before = JSON.stringify({
      permissions: { allow: ['Bash(git:*)'] },
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh' }] },
          { hooks: [{ type: 'command', command: OURS_CLAUDE }] },
        ],
        Notification: [{ hooks: [{ type: 'command', command: OURS_CLAUDE }] }],
      },
      statusLine: { type: 'command', command: OURS_STATUSLINE },
    }, null, 2)
    const stripped = wbHooksRemoveFrom(before)
    expect(stripped.ok).toBe(true)
    if (!stripped.ok) return
    const root = parse(stripped.result.text)
    expect(commands(root.hooks)).toEqual(['/opt/headroom/bin/headroom-hook.sh'])
    // 被摘空的那一项整项去掉,不留 `"Notification": []` 这种噪音。
    expect(root.Notification).toBeUndefined()
    expect(root.hooks.Notification).toBeUndefined()
    expect(root.statusLine).toBeUndefined()
    expect(root.permissions.allow).toEqual(['Bash(git:*)'])
    expect(stripped.result.removed).toBe(2)
    expect(stripped.result.statusLineRemoved).toBe(true)
  })

  it('同一组里我们的和别人的混在一起 → 只摘我们那条,组还在', () => {
    const before = JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ command: '/opt/他的.sh' }, { command: OURS_CODEX }] }] },
    })
    const stripped = wbHooksRemoveFrom(before)
    expect(stripped.ok).toBe(true)
    if (!stripped.ok) return
    const root = parse(stripped.result.text)
    expect(root.hooks.Stop[0].matcher).toBe('*')
    expect(commands(root.hooks)).toEqual(['/opt/他的.sh'])
  })

  it('他自己的状态栏不会被撤回顺手删掉', () => {
    const before = JSON.stringify({ statusLine: { command: '/opt/他自己的/status.sh' } })
    const stripped = wbHooksRemoveFrom(before)
    expect(stripped.ok && parse(stripped.result.text).statusLine.command).toBe('/opt/他自己的/status.sh')
  })

  it('接上 → 撤回,回到的内容与接之前一模一样', () => {
    const before = JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/他的.sh' }] }] },
    }, null, 2) + '\n'
    const merged = wbHooksMergeInto(before, 'claude', HOOKS)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const back = wbHooksRemoveFrom(merged.result.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.result.text).toBe(before)
  })
})

/** 真写盘的那一半。每个用例一个 mkdtemp 目录,绝不碰真实家目录。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hooks-apply-'))
  const home = join(dir, 'home')
  const file = join(home, '.claude', 'settings.json')
  return { dir, home, file, io: nodeSetupIo(), now: () => new Date(2026, 8, 17, 21, 42, 33) }
}

describe('真写盘:备份 → 写 → 撤回', () => {
  it('文件本来就不存在 → 直接生成,没有备份(没有东西可丢),父目录自己建出来', async () => {
    const box = sandbox()
    const result = await wbHooksApply({ io: box.io, now: box.now }, { agent: 'claude', file: box.file, hooksDir: HOOKS })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup_path).toBeUndefined()
    expect(commands(parse(readFileSync(box.file, 'utf8')).hooks)).toHaveLength(4)
  })

  it('★文件在 → 先备份到同目录 <原名>.bak-工作台-<时间戳>,内容是改之前那一份', async () => {
    const box = sandbox()
    const before = JSON.stringify({ model: 'opus' }, null, 2) + '\n'

    await box.io.writeFile(box.file, before)

    const result = await wbHooksApply({ io: box.io, now: box.now }, { agent: 'claude', file: box.file, hooksDir: HOOKS })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup_path).toBe(`${box.file}.${WB_HOOKS_BACKUP_TAG}-20260917-214233`)
    expect(readFileSync(result.backup_path ?? '', 'utf8')).toBe(before)
    expect(parse(readFileSync(box.file, 'utf8')).model).toBe('opus')
  })

  it('★备份写不出去 → 一个字都不写(目录只读)', async () => {
    const box = sandbox()
    const dir = join(box.home, '.claude')
    const before = JSON.stringify({ model: 'opus' }, null, 2)
    await box.io.writeFile(box.file, before)
    chmodSync(dir, 0o500) // r-x:能读、能进,不能新建文件
    try {
      const result = await wbHooksApply({ io: box.io, now: box.now }, { agent: 'claude', file: box.file, hooksDir: HOOKS })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('备份')
      // 原文一个字没变,而且没有留下半份备份。
      expect(readFileSync(box.file, 'utf8')).toBe(before)
      expect(readdirSync(dir)).toEqual(['settings.json'])
    }
    finally { chmodSync(dir, 0o700) }
  })

  it('★备份"成功了但对不上"也算失败 —— 只看 copy 没抛是不够的', async () => {
    const box = sandbox()
    await box.io.writeFile(box.file, JSON.stringify({ model: 'opus' }))
    const lyingIo = {
      ...box.io,
      // 假装复制成功,其实只写了半份(磁盘满的经典症状)。
      copyFile: async (_from: string, to: string) => { await box.io.writeFile(to, '半') },
    }
    const result = await wbHooksApply({ io: lyingIo, now: box.now }, { agent: 'claude', file: box.file, hooksDir: HOOKS })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('备份')
    expect(parse(readFileSync(box.file, 'utf8')).hooks).toBeUndefined()
  })

  /**
   * 卡「钩子备份同秒互盖」:时间戳只到秒,同一秒内第二次备份(点「全部接上」后马上点一家「撤回」)
   * 原来的实现会把第一份盖掉 —— `backup_path` 指向的已是改过一次的内容,原文那份备份没了。
   */
  it('★同一秒「接上 → 撤回」:第二份备份不盖第一份 —— 两份都在,接上的那份还是原文', async () => {
    const box = sandbox()
    const before = JSON.stringify({ model: 'opus' }, null, 2) + '\n'
    await box.io.writeFile(box.file, before)
    const base = `${box.file}.${WB_HOOKS_BACKUP_TAG}-20260917-214233`

    const applied = await wbHooksApply({ io: box.io, now: box.now }, { agent: 'claude', file: box.file, hooksDir: HOOKS })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.backup_path).toBe(base)

    const back = await wbHooksRevert({ io: box.io, now: box.now }, { file: box.file })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.removed).toBe(4)

    // 两次 backup_path 不相同;第一份备份读回来仍是最初的原文。
    expect(back.backup_path).not.toBe(applied.backup_path)
    expect(readFileSync(applied.backup_path ?? '', 'utf8')).toBe(before)
    // 撤回前那份备份记的是接上之后的内容(我们的工作台条目在里面)。
    expect(readFileSync(back.backup_path ?? '', 'utf8')).toContain(OURS_CLAUDE)
    // 目录里两份备份都在。
    expect(readdirSync(join(box.home, '.claude')).sort()).toEqual([
      'settings.json',
      `settings.json.${WB_HOOKS_BACKUP_TAG}-20260917-214233`,
      `settings.json.${WB_HOOKS_BACKUP_TAG}-20260917-214233-2`,
    ].sort())
  })

  it('★同一秒第三份备份再让一位(-3):接上 → 撤回 → 再接上,三份各是各的内容', async () => {
    const box = sandbox()
    const before = JSON.stringify({ model: 'opus' }, null, 2) + '\n'
    await box.io.writeFile(box.file, before)
    const deps = { io: box.io, now: box.now }

    const applied = await wbHooksApply(deps, { agent: 'claude', file: box.file, hooksDir: HOOKS })
    const back = await wbHooksRevert(deps, { file: box.file })
    const again = await wbHooksApply(deps, { agent: 'claude', file: box.file, hooksDir: HOOKS })
    expect(applied.ok && back.ok && again.ok).toBe(true)
    if (!applied.ok || !back.ok || !again.ok) return
    const base = `${box.file}.${WB_HOOKS_BACKUP_TAG}-20260917-214233`

    expect(applied.backup_path).toBe(base)
    expect(back.backup_path).toBe(`${base}-2`)
    expect(again.backup_path).toBe(`${base}-3`)
    expect(readFileSync(applied.backup_path ?? '', 'utf8')).toBe(before)
    expect(readFileSync(back.backup_path ?? '', 'utf8')).toContain(OURS_CLAUDE)
    // 第三份备的是「撤回之后」那一份:我们的条目一条不在,他自己的 model 还在。
    const thirdBackup = readFileSync(again.backup_path ?? '', 'utf8')
    expect(thirdBackup).not.toContain(OURS_CLAUDE)
    expect(thirdBackup).toContain('"model": "opus"')
    expect(readdirSync(join(box.home, '.claude'))).toHaveLength(4)
  })

  it('撤回:同样先备份,摘完别人的条目还在', async () => {
    const box = sandbox()
    await box.io.writeFile(box.file, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: '/opt/headroom/bin/headroom-hook.sh' }] }] },
    }, null, 2) + '\n')
    await wbHooksApply({ io: box.io, now: box.now }, { agent: 'claude', file: box.file, hooksDir: HOOKS })

    const back = await wbHooksRevert({ io: box.io, now: () => new Date(2026, 8, 17, 22, 0, 0) }, { file: box.file })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.removed).toBe(4)
    expect(back.statusLineRemoved).toBe(true)
    expect(back.backup_path).toBe(wbHooksBackupPath(box.file, new Date(2026, 8, 17, 22, 0, 0)))
    expect(commands(parse(readFileSync(box.file, 'utf8')).hooks)).toEqual(['/opt/headroom/bin/headroom-hook.sh'])
  })

  it('撤回一件没做过的事:不写、不备份、如实回 removed:0', async () => {
    const box = sandbox()
    const before = JSON.stringify({ model: 'opus' }, null, 2)
    await box.io.writeFile(box.file, before)
    const back = await wbHooksRevert({ io: box.io, now: box.now }, { file: box.file })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.removed).toBe(0)
    expect(back.backup_path).toBeUndefined()
    expect(readdirSync(join(box.home, '.claude'))).toEqual(['settings.json'])
    expect(readFileSync(box.file, 'utf8')).toBe(before)
  })

  it('文件压根不在:撤回不报错,也不会凭空造一个文件出来', async () => {
    const box = sandbox()
    const back = await wbHooksRevert({ io: box.io, now: box.now }, { file: box.file })
    expect(back.ok && back.removed).toBe(0)
    expect(() => readdirSync(join(box.home, '.claude'))).toThrow()
  })
})

describe('写完之后那句话', () => {
  it('两家都说「要重开」;★Codex 那句还要说去哪儿放行一次(新版 Codex 不放行就一条都不跑)', () => {
    expect(wbHooksRestartHint('claude')).toContain('重新开一个')
    expect(wbHooksRestartHint('claude')).not.toContain(CODEX_TRUST_HOW)
    expect(wbHooksRestartHint('codex')).toContain('重新开一个')
    expect(wbHooksRestartHint('codex')).toContain(CODEX_TRUST_HOW)
  })
})
