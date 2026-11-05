// @vitest-environment node
/**
 * hooks 生成器(2026-09-17 卡 C 第 4 条;2026-09-25 卡 R 改成「命令只指钩子脚本的固定位置」)。
 *
 * 卡 R 之前命令指的是「本机开发仓库」里的 `workbench-plugin/bin/agent-hook.sh` —— 普通用户机器上
 * 没有仓库,永远接不上。现在命令只指 `~/.dsh/workbench/hooks/`(插件每次起服务把脚本同步过去)。
 *
 * bin/ 里的两份 JSON 仍是**模板**(位置写成 `__WORKBENCH_HOOKS__`),
 * 最后一组用例盯着它们与生成器不走样——两份各写一遍的东西迟早会不一致。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CODEX_TRUST_HOW,
  WB_HOOKS_COMMAND_MARKERS,
  WB_HOOKS_PLACEHOLDER,
  WB_HOOKS_STATUSLINE_MARKERS,
  wbHooksDir,
  wbHooksInstructions,
  wbHooksMentionsOurScript,
  wbHooksMentionsOurStatusLine,
  wbHooksRender,
  wbHooksResolveRepoRoot,
} from '../src/server/hooksConfig.ts'

const HOME = '/Users/someone'
const HOOKS = `${HOME}/.dsh/workbench/hooks`
const REPO = '/Users/someone/Code/desktop-workbench'

function binJson(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), 'utf8'))
}

describe('固定位置', () => {
  it('~/.dsh/workbench/hooks —— 由家目录算,末尾斜杠不影响', () => {
    expect(wbHooksDir(HOME)).toBe(HOOKS)
    expect(wbHooksDir(`${HOME}/`)).toBe(HOOKS)
  })

  it('★家目录不知道(空 / 根)→ 不给位置,绝不往根目录下放东西', () => {
    expect(wbHooksDir('')).toBeUndefined()
    expect(wbHooksDir('/')).toBeUndefined()
  })
})

describe('渲染 hooks', () => {
  it('Claude:四条 hook + statusLine,全指固定位置上的脚本,不提任何仓库', () => {
    const rendered = wbHooksRender('claude', HOOKS)
    expect(Object.keys(rendered.hooks)).toEqual(['Notification', 'Stop', 'UserPromptSubmit', 'SessionEnd'])
    const commands = Object.values(rendered.hooks).map(group => group[0]!.hooks[0]!.command)
    expect(commands).toEqual(Array(4).fill(`${HOOKS}/agent-hook.sh claude`))
    expect(rendered.statusLine?.command).toBe(`${HOOKS}/claude-statusline.sh`)
    expect(JSON.stringify(rendered)).not.toContain('workbench-plugin')
    expect(JSON.stringify(rendered)).not.toContain('/Users/example/')
  })

  it('Codex:三条 hook(Stop / UserPromptSubmit / SessionEnd),没有 statusLine', () => {
    const rendered = wbHooksRender('codex', HOOKS)
    expect(Object.keys(rendered.hooks)).toEqual(['Stop', 'UserPromptSubmit', 'SessionEnd'])
    expect(rendered.hooks.Stop![0]!.hooks[0]!.command).toBe(`${HOOKS}/agent-hook.sh codex`)
    // Codex 没有 Notification(拿不到「等你确认」),这里绝不为它假造一条(hooks.ts 顶部同一条纪律)。
    expect(rendered.hooks.Notification).toBeUndefined()
    // statusLine 是 Claude Code 独有的,Codex 的 ~/.codex/hooks.json 里没有这一节。
    expect(rendered.statusLine).toBeUndefined()
  })

  /**
   * ★逐字钉死(2026-10-21)。Codex 按「事件 + matcher + 命令 + 钳过的超时 + async + statusMessage」
   * 算指纹,她点过的「信任」只认这个指纹 —— 这里改一个字,她那几条就悄悄变回「没放行」、一条都不跑。
   * 要改就得同时让体检页把「再放行一次」亮出来(codexHookTrust.ts 会如实报 modified)。
   *
   * SessionEnd 写 3 秒:Codex 把它钳到最多 3 秒,写 5 每次 `codex exec` 都打一行警告;钳过之后指纹相同,
   * 所以 5 → 3 不会让已放行的作废(10-21 用 `hooks/list` 对着临时 CODEX_HOME 实测过)。
   */
  it('★Codex 那三条逐字钉死:命令只指固定位置,改一个字她点过的信任就作废', () => {
    const command = `${HOOKS}/agent-hook.sh codex`
    expect(wbHooksRender('codex', HOOKS)).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 3 }] }],
      },
    })
  })

  it('位置末尾的斜杠不会渲染出双斜杠', () => {
    const rendered = wbHooksRender('claude', `${HOOKS}/`)
    expect(rendered.hooks.Stop![0]!.hooks[0]!.command).toBe(`${HOOKS}/agent-hook.sh claude`)
  })

  it('说明是一段人话:点名要合并进哪个文件;★不提仓库,也不叫他去改设置', () => {
    const claude = wbHooksInstructions('claude')
    expect(claude).toContain('~/.claude/settings.json')
    expect(claude).toContain('合并')
    expect(wbHooksInstructions('codex')).toContain('~/.codex/hooks.json')
    // 新版 Codex 不放行就一条都不跑:手工贴的人也要知道去哪儿点(2026-10-21)。
    expect(wbHooksInstructions('codex')).toContain(CODEX_TRUST_HOW)
    expect(claude).not.toContain(CODEX_TRUST_HOW)
    for (const text of [claude, wbHooksInstructions('codex')]) {
      expect(text).not.toContain('仓库')
      expect(text).not.toContain('workbench-plugin')
    }
  })
})

describe('认「工作台自己的」:新旧两种位置都认', () => {
  it('新位置(固定位置)与旧位置(开发仓库里)都认,别人的不认', () => {
    expect(wbHooksMentionsOurScript(`${HOOKS}/agent-hook.sh claude`)).toBe(true)
    expect(wbHooksMentionsOurScript(`${REPO}/workbench-plugin/bin/agent-hook.sh claude`)).toBe(true)
    expect(wbHooksMentionsOurScript('/Users/example/Documents/GitHub/desktop-workbench/workbench-plugin/bin/agent-hook.sh codex')).toBe(true)
    expect(wbHooksMentionsOurScript('/opt/headroom/bin/headroom-hook.sh stop')).toBe(false)
    expect(wbHooksMentionsOurScript('/Users/someone/bin/agent-hook.sh claude')).toBe(false)

    expect(wbHooksMentionsOurStatusLine(`${HOOKS}/claude-statusline.sh`)).toBe(true)
    expect(wbHooksMentionsOurStatusLine(`${REPO}/workbench-plugin/bin/claude-statusline.sh`)).toBe(true)
    expect(wbHooksMentionsOurStatusLine('/opt/他自己的/status.sh')).toBe(false)
  })

  it('★渲染出来的每一条都认得出是自己的(写进去的与认出来的是同一套判据)', () => {
    const claude = wbHooksRender('claude', HOOKS)
    for (const groups of Object.values(claude.hooks)) {
      expect(wbHooksMentionsOurScript(groups[0]!.hooks[0]!.command)).toBe(true)
    }
    expect(wbHooksMentionsOurStatusLine(claude.statusLine?.command ?? '')).toBe(true)
    expect(WB_HOOKS_COMMAND_MARKERS).toHaveLength(2)
    expect(WB_HOOKS_STATUSLINE_MARKERS).toHaveLength(2)
  })
})

/**
 * 找开发仓库:卡 R 之后**钩子不再走这里**,只剩技能正文「仓库优先、包内兜底」与进化那条技能路在用。
 * 行为一个字没改(那两处的接线也没动),用例照留。
 */
describe('开发仓库从哪来(技能正文用;钩子不再用)', () => {
  const marker = 'workbench-plugin/bin/agent-hook.sh'

  it('插件跑在仓库里:从自己所在目录往上找到带 agent-hook.sh 的那一层', async () => {
    const resolved = await wbHooksResolveRepoRoot({
      moduleDir: `${REPO}/workbench-plugin/src/server`,
      exists: async path => path === `${REPO}/${marker}`,
    })
    expect(resolved).toEqual({ root: REPO, source: 'plugin' })
  })

  it('插件是装好的 tgz(仓库不在身边):退回 butler_cwd', async () => {
    const resolved = await wbHooksResolveRepoRoot({
      moduleDir: '/Users/someone/.dsh/runtime/node_modules/@ben/dsh-workbench/lib',
      butlerCwd: REPO,
      exists: async path => path === `${REPO}/${marker}`,
    })
    expect(resolved).toEqual({ root: REPO, source: 'butler_cwd' })
  })

  it('butler_cwd 指的仓库里也没有那个脚本 → 认不出来,不猜', async () => {
    expect(await wbHooksResolveRepoRoot({
      moduleDir: '/somewhere/else',
      butlerCwd: '/not/the/repo',
      exists: async () => false,
    })).toBeUndefined()
  })
})

describe('bin/ 里的模板与生成器同源', () => {
  it('claude-settings.hooks.json 就是占位符版的渲染结果', () => {
    expect(binJson('claude-settings.hooks.json')).toEqual(wbHooksRender('claude', WB_HOOKS_PLACEHOLDER))
  })

  it('codex-hooks.json 就是占位符版的渲染结果(不含 headroom 那部分)', () => {
    const template = binJson('codex-hooks.json')
    expect(template).toEqual(wbHooksRender('codex', WB_HOOKS_PLACEHOLDER))
    expect(JSON.stringify(template)).not.toContain('headroom')
  })

  it('两份模板里都没有任何一台具体机器的家目录,也不再指开发仓库', () => {
    for (const name of ['claude-settings.hooks.json', 'codex-hooks.json']) {
      expect(JSON.stringify(binJson(name))).not.toContain('/Users/')
      expect(JSON.stringify(binJson(name))).not.toContain('workbench-plugin')
    }
  })
})
