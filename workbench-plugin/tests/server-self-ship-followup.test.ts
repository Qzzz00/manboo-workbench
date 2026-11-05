// @vitest-environment node
/**
 * 「改自己」那条闭环重启之后的**收尾**(2026-09-23)。
 *
 * ## 这一份在钉什么
 *
 * 第 ⑧ 步按下 `/update/apply` 就回了,它没有办法在原地等到结果 ——
 * 那一下会把跑着那条请求的进程换掉并重启。于是进化日志里那一节此刻标着
 * 「待重启确认」,**必须有人回头把它变成结论**。这一份钉的就是那个"回头":
 *
 * 1. 对上了:日志那一行改成「已生效」,收件箱一条**好消息**;
 * 2. 对不上:日志**一个字节都不动**(它仍然是实情),收件箱一条**带原话**的坏消息;
 * 3. 绝大多数次什么都不做:日志不在 / 一节都没有 / 最近那一节不是待确认;
 * 4. 「当前运行版本」读的是**装到盘上那一份** package.json —— 不是进程里那个
 *    构建时注入的 `PLUGIN_VERSION`(见 selfShipFollowUp.ts 文件头)。
 *
 * **这一份一次都没有真按过更新**:`runningVersion` 是注进来的,I/O 全在内存 Map 里。
 */
import { describe, expect, it } from 'vitest'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'
import type { SelfShipFollowUp } from '../src/server/selfShipFollowUp.ts'
import { installedPluginVersion, runSelfShipFollowUp } from '../src/server/selfShipFollowUp.ts'
import {
  EVOLUTION_CONFIRMED, EVOLUTION_LOG_REL, EVOLUTION_PENDING,
  evolutionSection, joinRel, parseLatestEvolution,
} from '../src/server/selfUpdate.ts'

const REPO = '/tmp/假仓库'
const LOG = joinRel(REPO, EVOLUTION_LOG_REL)
const NOW = new Date('2026-09-23T12:00:00.000Z')

/** 一份进化日志:两节,最后那一节是刚发的 `version`。 */
function logWith(version: string, over: { status?: string } = {}): string {
  const older = evolutionSection({
    day: '2026-09-20', what: '老的那一版', who: '事务官(DSH 会话 sess-0)', version: '0.2.63',
    status: `${EVOLUTION_CONFIRMED}(早就确认过了)`,
  })
  const latest = evolutionSection({
    day: '2026-09-23', what: '座机页的时钟大了一号', who: '事务官(DSH 会话 sess-1)',
    version, previousVersion: '0.2.64', commit: 'abc1234',
    ...(over.status === undefined ? {} : { status: over.status }),
  })
  return `# 进化日志\n\n每一次「改自己」在这里留一条。\n\n${older}\n${latest}`
}

/** 一份内存里的假盘。**没有一次真的读写文件**。 */
function disk(files: Record<string, string>) {
  const store = new Map(Object.entries(files))
  return {
    store,
    readText: async (path: string) => store.get(path),
    writeText: async (path: string, text: string) => { store.set(path, text) },
  }
}

describe('收尾:对上了', () => {
  it('把那一行改成「已生效」,并在收件箱里说一句(带上发版时那句人话)', async () => {
    const before = logWith('0.2.65')
    const fs = disk({ [LOG]: before })
    const result = await runSelfShipFollowUp({
      projectPath: REPO,
      readText: fs.readText,
      writeText: fs.writeText,
      runningVersion: async () => '0.2.65',
      now: () => NOW,
    })

    expect(result?.ok).toBe(true)
    expect(result?.version).toBe('0.2.65')
    expect(result?.running).toBe('0.2.65')
    expect(result?.what).toBe('座机页的时钟大了一号')
    expect(result?.note).toContain('座机页的时钟大了一号')
    expect(result?.at).toBe(NOW.toISOString())

    // 日志里最近那一节的状态真的改了,而且**把对上的那一刻写了进去**。
    const after = fs.store.get(LOG) as string
    const latest = parseLatestEvolution(after)
    expect(latest?.status).toContain(EVOLUTION_CONFIRMED)
    expect(latest?.status).toContain(NOW.toISOString())
    expect(latest?.status).not.toContain(EVOLUTION_PENDING)
    /**
     * ★ **只改那一行**:逐行比一遍,不一样的**有且只有**状态那一行。
     * 这是一份人会读的历史,一次"顺手重排"就是改历史。
     */
    const was = before.split('\n')
    const now = after.split('\n')
    expect(now).toHaveLength(was.length)
    const diff = now.map((line, i) => (line === was[i] ? undefined : i)).filter(one => one !== undefined)
    expect(diff).toEqual([latest?.statusLine])
    expect(after).toContain('早就确认过了')
  })
})

describe('收尾:对不上', () => {
  it('日志**一个字节都不动**,收件箱那一条**带原话**说清现在是哪一版', async () => {
    const before = logWith('0.2.65')
    const fs = disk({ [LOG]: before })
    const result = await runSelfShipFollowUp({
      projectPath: REPO,
      readText: fs.readText,
      writeText: fs.writeText,
      // 装到盘上的还是老那一版 —— 更新没落地。
      runningVersion: async () => '0.2.64',
      now: () => NOW,
    })

    expect(result?.ok).toBe(false)
    expect(result?.version).toBe('0.2.65')
    expect(result?.running).toBe('0.2.64')
    expect(result?.note).toContain('0.2.65')
    expect(result?.note).toContain('0.2.64')
    expect(result?.note).toContain(EVOLUTION_PENDING)
    expect(result?.note).toContain('检查更新')
    // ★ 日志原样:它记着的仍是实情(触发过,但还没生效)。**不替它下结论**。
    expect(fs.store.get(LOG)).toBe(before)
  })

  it('那份 package.json 读不出来时如实说「不详」,**不猜一个版本号**', async () => {
    const fs = disk({ [LOG]: logWith('0.2.65') })
    const result = await runSelfShipFollowUp({
      projectPath: REPO,
      readText: fs.readText,
      writeText: fs.writeText,
      runningVersion: async () => undefined,
      now: () => NOW,
    })
    expect(result?.ok).toBe(false)
    expect(result?.running).toBeUndefined()
    expect(result?.note).toContain('不详')
  })
})

describe('收尾:绝大多数次什么都不做', () => {
  it('进化日志不在 —— 回 undefined', async () => {
    const fs = disk({})
    expect(await runSelfShipFollowUp({
      projectPath: REPO, readText: fs.readText, writeText: fs.writeText,
      runningVersion: async () => '0.2.65', now: () => NOW,
    })).toBeUndefined()
  })

  it('最近那一节已经是「已生效」—— 回 undefined,不再说第二遍', async () => {
    const fs = disk({ [LOG]: logWith('0.2.65', { status: `${EVOLUTION_CONFIRMED}(上一次启动就确认过了)` }) })
    expect(await runSelfShipFollowUp({
      projectPath: REPO, readText: fs.readText, writeText: fs.writeText,
      runningVersion: async () => '0.2.65', now: () => NOW,
    })).toBeUndefined()
  })

  it('一节都没有(空日志)—— 回 undefined', async () => {
    const fs = disk({ [LOG]: '# 进化日志\n\n还没有过一条。\n' })
    expect(await runSelfShipFollowUp({
      projectPath: REPO, readText: fs.readText, writeText: fs.writeText,
      runningVersion: async () => '0.2.65', now: () => NOW,
    })).toBeUndefined()
  })
})

describe('「当前运行版本」读的是装到盘上那一份', () => {
  it('读 package.json 里的 version;读不出回 undefined(不退回进程里那一个)', async () => {
    const path = '/假/profiles/web/node_modules/@ben/dsh-workbench/package.json'
    const fs = disk({ [path]: JSON.stringify({ name: '@ben/dsh-workbench', version: '0.2.65' }) })
    expect(await installedPluginVersion(path, fs.readText)).toBe('0.2.65')
    expect(await installedPluginVersion('/不在的/package.json', fs.readText)).toBeUndefined()
    const broken = disk({ [path]: '{ 这不是 JSON' })
    expect(await installedPluginVersion(path, broken.readText)).toBeUndefined()
  })
})

describe('收件箱里那一条', () => {
  const base = { sessions: [] as never[] }

  it('生效了:一条好消息,**不带 wait_reason**(它不是一件要人处理的事)', () => {
    const followUp: SelfShipFollowUp = {
      ok: true, version: '0.2.65', what: '时钟大一号', note: '已经跑起来了', at: NOW.toISOString(),
    }
    const view = deriveButlerInbox({ ...base, shipFollowUp: followUp })
    const item = view.items.find(one => one.id === 'ship:followup:0.2.65')
    expect(item?.kind).toBe('ship')
    expect(item?.title).toBe('上一版已生效:0.2.65')
    expect(item?.note).toBe('已经跑起来了')
    expect(item?.wait_reason).toBeUndefined()
    expect(item?.at).toBe(NOW.toISOString())
  })

  it('没生效:标题说清没生效,note 是**原话**,wait_reason 是 error', () => {
    const followUp: SelfShipFollowUp = {
      ok: false, version: '0.2.65', running: '0.2.64', note: '这台电脑上装着的是 0.2.64。', at: NOW.toISOString(),
    }
    const item = deriveButlerInbox({ ...base, shipFollowUp: followUp }).items
      .find(one => one.id === 'ship:followup:0.2.65')
    expect(item?.title).toContain('更新没生效')
    expect(item?.note).toBe('这台电脑上装着的是 0.2.64。')
    expect(item?.wait_reason).toBe('error')
  })

  it('没有上一版待确认时这一档整档不出', () => {
    expect(deriveButlerInbox({ ...base }).items.filter(one => one.kind === 'ship')).toEqual([])
  })
})
