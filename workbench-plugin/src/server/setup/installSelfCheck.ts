/**
 * **安装器末尾自检三件**(2026-10-21,卡「引导三件事」;设计稿第二节第 2 条)。
 *
 * 装完不只说「装上了」:早报、交代、电话三样各写一行「成 / 没成 + 缺哪道门」(缺模型钥匙、没登录哪家 AI、
 * 手机没配对……),**不说「都好了」**。行怎么写在 `src/mainPaths.ts` 的 `selfCheckLine`,与工作台里同一句。
 *
 * 两条路:
 *   · 服务起来了 → {@link liveSelfCheck}:打 8791 的 `/first-use/selfcheck` 真跑一遍(早报一份、派一件、拉起通话);
 *   · 没起服务(隔离环境 `--no-launch`,或等不到 8791)→ {@link offlineSelfCheck}:只看本机几个文件,
 *     写得出的门照写,写不出的如实说「这一遍没起服务,没真跑」。新机器演练(`pnpm rehearse`)接的是这一版,
 *     行的形状给它 {@link rehearseRowsOf}。
 *
 * 读 model.json 只认「领没领到令牌」,令牌本身**一个字都不往外带**。
 */
import {
  MAIN_PATH_TITLES, doorView, selfCheckLine, selfCheckSummary,
  type FirstUseDoor, type MainPath, type SelfCheckRow,
} from '../../mainPaths.ts'
import { parseModelConfig } from '../modelConfig.ts'
import type { InstallerEvent } from './installer.ts'

export interface OfflineFacts {
  /** 模型接上了没(model.json 领到令牌)。用自己的钥匙那种这里看不出来 = `undefined`。 */
  model: boolean | undefined
  coders: readonly { family: string, title: string, found: boolean }[]
  phonePaired: boolean
  workerInstalled: boolean
  /** 为什么没真跑(进那一句里)。 */
  why: string
}

export function offlineSelfCheck(facts: OfflineFacts): SelfCheckRow[] {
  const notRun = (path: MainPath): SelfCheckRow => ({
    path,
    state: 'missing',
    door: { ...doorView('service'), text: `${facts.why},没真跑;打开工作台后在设置里再试一遍。` },
  })
  const door = (path: MainPath, key: FirstUseDoor): SelfCheckRow => ({ path, state: 'missing', door: doorView(key) })
  return [
    facts.model === false ? door('morning', 'model') : notRun('morning'),
    facts.coders.some(one => one.found) ? notRun('delegate') : door('delegate', 'ai_missing'),
    !facts.phonePaired ? door('call', 'phone') : !facts.workerInstalled ? door('call', 'worker') : notRun('call'),
  ]
}

export async function readOfflineFacts(input: {
  dshHome: string
  home: string
  readFile: (file: string) => Promise<string>
  exists: (file: string) => Promise<boolean>
  why?: string
}): Promise<OfflineFacts> {
  const read = async (file: string): Promise<string | undefined> => { try { return await input.readFile(file) } catch { return undefined } }
  const modelText = await read(`${input.dshHome}/workbench/model.json`)
  const config = modelText === undefined ? undefined : parseModelConfig(modelText, () => 'self-check')
  const model = config === undefined ? false : config.mode === 'own' ? undefined : config.relay_token !== undefined
  let phonePaired = false
  try {
    const parsed = JSON.parse((await read(`${input.dshHome}/workbench/devices.json`)) ?? '{}') as { devices?: { platform?: unknown, revokedAt?: unknown }[] }
    phonePaired = (parsed.devices ?? []).some(one => one.revokedAt === undefined && typeof one.platform === 'string' && one.platform.toLowerCase() !== 'handset')
  }
  catch { phonePaired = false }
  const anyOf = async (files: readonly string[]): Promise<boolean> => {
    for (const file of files) if (await input.exists(file)) return true
    return false
  }
  const claude = await anyOf([`${input.home}/.local/bin/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${input.home}/.claude/local/claude`])
  const codex = await anyOf(['/Applications/Codex.app', `${input.home}/Applications/Codex.app`, '/opt/homebrew/bin/codex', '/usr/local/bin/codex'])
  return {
    model,
    coders: [{ family: 'claude', title: 'Claude', found: claude }, { family: 'codex', title: 'Codex', found: codex }],
    phonePaired,
    workerInstalled: await input.exists(`${input.dshHome}/channel-worker`),
    why: input.why ?? '这一遍没起服务',
  }
}

/**
 * 打 8791 真跑一遍:起自检、隔一会儿看一眼,直到三行都不是「在试」(交代那件派出去没回算「在路上」,也算有结果)。
 * 打不通 / 超时还没出来 → `undefined`(调用方退回只看文件那一版)。
 */
export async function liveSelfCheck(input: {
  baseUrl: string
  fetchImpl?: typeof fetch
  pollMs?: number
  timeoutMs?: number
  now?: () => number
}): Promise<SelfCheckRow[] | undefined> {
  const doFetch = input.fetchImpl ?? fetch
  const now = input.now ?? Date.now
  const deadline = now() + (input.timeoutMs ?? 180_000)
  const pollMs = input.pollMs ?? 2000
  try {
    const kicked = await doFetch(`${input.baseUrl}/first-use/selfcheck`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (kicked.status !== 202 && kicked.status !== 200) return undefined
    let last: SelfCheckRow[] | undefined
    while (now() <= deadline) {
      const got = await doFetch(`${input.baseUrl}/first-use/selfcheck`)
      if (got.ok) {
        const view = await got.json() as { rows?: SelfCheckRow[], ended_at?: string }
        last = view.rows
        if (view.ended_at !== undefined && last !== undefined) return last
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return last?.every(one => one.state !== 'running') === true ? last : undefined
  }
  catch {
    return undefined
  }
}

/** 一行一件(`check`)+ 一句总结(`note`)。安装器界面与命令行原样显示。 */
export function checkEventsOf(rows: readonly SelfCheckRow[]): InstallerEvent[] {
  const checks = rows.map((row): InstallerEvent => ({
      t: 'check',
      key: row.path,
      title: MAIN_PATH_TITLES[row.path],
      ok: row.state === 'ok',
      state: row.state,
      line: selfCheckLine(row),
      ...(row.door === undefined ? {} : { gate: row.door.door }),
      ...(row.door === undefined ? {} : { fixes: row.door.fixes.map(fix => ({ kind: fix.kind, label: fix.label, ...(fix.family === undefined ? {} : { family: fix.family }) })) }),
  }))
  return [...checks, { t: 'note', text: selfCheckSummary(rows) }]
}

/** 新机器演练要的那一行(`{ key, title, ok, gate?, detail }`)。 */
export function rehearseRowsOf(rows: readonly SelfCheckRow[]): { key: string, title: string, ok: boolean, gate?: string, detail: string }[] {
  return rows.map(row => ({
    key: row.path,
    title: MAIN_PATH_TITLES[row.path],
    ok: row.state === 'ok',
    ...(row.door === undefined ? {} : { gate: row.door.door }),
    detail: selfCheckLine(row),
  }))
}
