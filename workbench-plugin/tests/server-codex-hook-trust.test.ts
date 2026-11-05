// @vitest-environment node
/**
 * Codex 放没放行工作台的钩子(2026-10-21,卡「Codex 钩子信任」)。
 *
 * 新版 Codex(codex-cli 0.162,ChatGPT 桌面版自带)对没被她「信任」过的钩子**一律静悄悄跳过**,
 * `codex exec` 与桌面 App 都一样。10-21 本机实测:`hooks/list` 报我们三条 `untrusted`,
 * 同一次 `codex exec` 里已信任的 headroom 那条跑了,我们的一条没跑。
 *
 * 判据只认 Codex 自己的回答(app-server 的 `hooks/list` → 每条的 `trustStatus`),
 * **不自己复刻它的指纹算法**:那是它的内部细节,升级一次就可能对不上,我们会把「已信任」说成「没放行」。
 *
 * 用例一个真进程都不起:`ask` 是假的,文件是内存里的。
 */
import { describe, expect, it } from 'vitest'
import {
  CODEX_HOOK_TRUST_METHOD,
  codexHookTrustFromList,
  createCodexHookTrustProbe,
} from '../src/server/codexHookTrust.ts'

const HOME = '/Users/someone'
const HOOKS_FILE = `${HOME}/.codex/hooks.json`
const CONFIG_FILE = `${HOME}/.codex/config.toml`
const OURS = `${HOME}/.dsh/workbench/hooks/agent-hook.sh codex`
const HEADROOM = `${HOME}/.local/bin/headroom init hook ensure --profile init-user --marker headroom-init-codex`
const AI_MEMORY = `${HOME}/.local/bin/ai-memory --data-dir ${HOME}/.local/share/ai-memory-probe/data hook --event stop --agent codex`

type Trust = 'trusted' | 'untrusted' | 'modified' | 'managed'

/** `hooks/list` 回来的一条,形状照 codex-cli 0.162 的 schema(`HookMetadata`)。 */
function hook(event: string, index: number, command: string, trustStatus: Trust, enabled = true): Record<string, unknown> {
  const label = event.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)
  return {
    key: `${HOOKS_FILE}:${label}:${index}:0`,
    eventName: event,
    handlerType: 'command',
    command,
    async: false,
    trustStatus,
    enabled,
    isManaged: trustStatus === 'managed',
    source: 'user',
    sourcePath: HOOKS_FILE,
    currentHash: 'sha256:0000',
    displayOrder: 0,
    timeoutSec: 5,
  }
}

function listed(...hooks: Record<string, unknown>[]): unknown {
  return { data: [{ cwd: HOME, hooks, warnings: [], errors: [] }] }
}

/** 维护者这台 10-21 的样子(路径换成 someone):headroom 两条信任过,我们三条与 ai-memory 都没有。 */
const BEN_1021 = listed(
  hook('preToolUse', 0, HEADROOM, 'trusted'),
  hook('sessionStart', 0, HEADROOM, 'trusted'),
  hook('sessionEnd', 0, OURS, 'untrusted'),
  hook('sessionEnd', 1, AI_MEMORY, 'untrusted'),
  hook('userPromptSubmit', 0, OURS, 'untrusted'),
  hook('userPromptSubmit', 1, AI_MEMORY, 'untrusted'),
  hook('stop', 0, OURS, 'untrusted'),
  hook('stop', 1, AI_MEMORY, 'untrusted'),
)

describe('读 Codex 自己的回答', () => {
  it('★维护者这台 10-21:我们三条都没放行 → needs_review,别人的条目不算数', () => {
    expect(codexHookTrustFromList(BEN_1021)).toEqual({ state: 'needs_review', count: 3, pending: 3, modified: 0 })
  })

  it('三条都信任过 → trusted', () => {
    const all = listed(
      hook('stop', 0, OURS, 'trusted'),
      hook('userPromptSubmit', 0, OURS, 'trusted'),
      hook('sessionEnd', 0, OURS, 'trusted'),
      hook('stop', 1, AI_MEMORY, 'untrusted'),
    )
    expect(codexHookTrustFromList(all)).toEqual({ state: 'trusted', count: 3 })
  })

  it('管理员统一下发的(managed)也算放行', () => {
    expect(codexHookTrustFromList(listed(hook('stop', 0, OURS, 'managed')))).toEqual({ state: 'trusted', count: 1 })
  })

  it('★改过 / 挪过位置(modified)→ 也要重新放行,并且说得出有几条是这一种', () => {
    const moved = listed(
      hook('stop', 0, OURS, 'modified'),
      hook('userPromptSubmit', 0, OURS, 'trusted'),
      hook('sessionEnd', 0, OURS, 'trusted'),
    )
    expect(codexHookTrustFromList(moved)).toEqual({ state: 'needs_review', count: 3, pending: 1, modified: 1 })
  })

  it('信任过、但她在 Codex 里把它关了 → disabled(点「信任」没用,要打开)', () => {
    const off = listed(
      hook('stop', 0, OURS, 'trusted', false),
      hook('userPromptSubmit', 0, OURS, 'trusted'),
    )
    expect(codexHookTrustFromList(off)).toEqual({ state: 'disabled', count: 2, disabled: 1 })
  })

  it('★旧位置(开发仓库里)的那种条目也认得 —— 与代写、撤回同一个判据', () => {
    const old = listed(hook('stop', 0, '/Users/someone/Code/desktop-workbench/workbench-plugin/bin/agent-hook.sh codex', 'untrusted'))
    expect(codexHookTrustFromList(old)).toEqual({ state: 'needs_review', count: 1, pending: 1, modified: 0 })
  })

  it('Codex 一条工作台的都没列出来 → not_loaded(文件里有,它没认)', () => {
    expect(codexHookTrustFromList(listed(hook('stop', 0, HEADROOM, 'trusted')))).toEqual({ state: 'not_loaded' })
  })

  it('同一条在两个 cwd 下各列一次 → 只数一次', () => {
    const twice = { data: [
      { cwd: HOME, hooks: [hook('stop', 0, OURS, 'trusted')], warnings: [], errors: [] },
      { cwd: '/tmp', hooks: [hook('stop', 0, OURS, 'trusted')], warnings: [], errors: [] },
    ] }
    expect(codexHookTrustFromList(twice)).toEqual({ state: 'trusted', count: 1 })
  })

  it('★认不出的形状 → unknown,不猜成「没放行」也不猜成「放行了」', () => {
    for (const raw of [undefined, null, 'x', {}, { data: 'x' }, { data: [{ hooks: 'x' }] }]) {
      expect(codexHookTrustFromList(raw)).toEqual({ state: 'unknown' })
    }
  })
})

/** 内存里的两个文件 + 一个记账的假 `ask`。 */
function rig(files: Record<string, string | undefined>, answer: () => Promise<unknown>) {
  const calls: { method: string, params: unknown }[] = []
  let now = 0
  const probe = createCodexHookTrustProbe({
    readFile: async path => files[path],
    ask: async (method, params) => { calls.push({ method, params }); return await answer() },
    hooksFile: HOOKS_FILE,
    configFile: CONFIG_FILE,
    cwd: HOME,
    now: () => now,
    retryMs: 1000,
  })
  return { probe, calls, files, tick: (ms: number) => { now += ms } }
}

const HOOKS_WITH_OURS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: OURS, timeout: 5 }] }] } })

describe('问 Codex 的那一下:只在该问的时候问', () => {
  it('★配置里没有工作台的钩子 → not_wired,一个进程都不起(没接过 Codex 的人不该被问到)', async () => {
    const headroomOnly = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HEADROOM }] }] } })
    for (const text of [undefined, '', headroomOnly]) {
      const { probe, calls } = rig({ [HOOKS_FILE]: text }, async () => BEN_1021)
      expect(await probe.check()).toEqual({ state: 'not_wired' })
      expect(calls).toEqual([])
    }
  })

  it('有工作台的钩子 → 问一次 hooks/list,cwd 是家目录', async () => {
    const { probe, calls } = rig({ [HOOKS_FILE]: HOOKS_WITH_OURS }, async () => BEN_1021)
    expect(await probe.check()).toEqual({ state: 'needs_review', count: 3, pending: 3, modified: 0 })
    expect(calls).toEqual([{ method: CODEX_HOOK_TRUST_METHOD, params: { cwds: [HOME] } }])
    expect(CODEX_HOOK_TRUST_METHOD).toBe('hooks/list')
  })

  it('★两个文件都没变 → 不再问(起一次 codex app-server 要一秒多,体检一分钟跑一次)', async () => {
    const { probe, calls, tick } = rig({ [HOOKS_FILE]: HOOKS_WITH_OURS, [CONFIG_FILE]: 'model = "x"\n' }, async () => BEN_1021)
    await probe.check()
    tick(60 * 60 * 1000)
    await probe.check()
    expect(calls).toHaveLength(1)
  })

  it('★她在 Codex 里点了信任(config.toml 变了)→ 重问一次,拿到新结论', async () => {
    let answer = BEN_1021
    const { probe, calls, files } = rig({ [HOOKS_FILE]: HOOKS_WITH_OURS, [CONFIG_FILE]: 'model = "x"\n' }, async () => answer)
    expect((await probe.check()).state).toBe('needs_review')
    files[CONFIG_FILE] = 'model = "x"\n[hooks.state."k"]\ntrusted_hash = "sha256:1"\n'
    answer = listed(hook('stop', 0, OURS, 'trusted'))
    expect(await probe.check()).toEqual({ state: 'trusted', count: 1 })
    expect(calls).toHaveLength(2)
  })

  it('钩子文件变了(重新接过)→ 也重问', async () => {
    const { probe, calls, files } = rig({ [HOOKS_FILE]: HOOKS_WITH_OURS }, async () => BEN_1021)
    await probe.check()
    files[HOOKS_FILE] = `${HOOKS_WITH_OURS}\n`
    await probe.check()
    expect(calls).toHaveLength(2)
  })

  it('★问不到(Codex 没装、起不来、老版本不认这一问)→ unknown;隔一阵再问,不是每拍都起进程', async () => {
    const { probe, calls, tick } = rig({ [HOOKS_FILE]: HOOKS_WITH_OURS }, async () => { throw new Error('spawn codex ENOENT') })
    expect(await probe.check()).toEqual({ state: 'unknown' })
    tick(500)
    expect(await probe.check()).toEqual({ state: 'unknown' })
    expect(calls).toHaveLength(1)
    tick(600)
    await probe.check()
    expect(calls).toHaveLength(2)
  })

  it('同一时刻两处一起问(体检与别处)→ 只起一个进程', async () => {
    let release: (value: unknown) => void = () => {}
    const { probe, calls } = rig({ [HOOKS_FILE]: HOOKS_WITH_OURS }, async () => await new Promise((resolve) => { release = resolve }))
    const first = probe.check()
    const second = probe.check()
    for (let spin = 0; spin < 50 && calls.length === 0; spin += 1) await Promise.resolve()
    release(BEN_1021)
    expect(await first).toEqual(await second)
    expect(calls).toHaveLength(1)
  })
})
