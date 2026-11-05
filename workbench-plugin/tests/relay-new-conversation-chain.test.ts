// @vitest-environment node
/**
 * 派活链路故障 ② ③(2026-09-30 晚,Air 诊断包 195508)。
 *
 * 维护者定的验收口径:**指派记录 → 指令投递 → 完成事件 → 电话打通**,任一步失败都明确报失败。
 *
 * ② 电话里「新开一条发给豆包」:壳按了发送、对话区里没当场核上(`status:'typed'`),
 *    以前直接回「没发出去」、**也不登记回电** —— 豆包其实收到了、两分钟后就回了,电话一直没来。
 * ③ 回电巡检读窗读错了包(一台机器装两个豆包,按家名 `doubao` 查到主包那扇窗),永远读不到回话;
 *    电话里问「豆包回了没」,窗口型那几家读不出对话,只能说「看不到」。
 *
 * 这一份钉的是:
 * - 投递那一步三档说实话:核上了 / 按了发送没核上(照样盯着) / 没发出去(明确失败);
 * - 盯没盯上也说实话:回电没登记上就明说「不会自己打电话」;
 * - 盯的时候按**真送进去的那个包**读窗;
 * - 没核上的那条等过头时,回电明说「没核实到发出去」,不说成「它还没回」;
 * - 「看一眼」时把捎话账上那一条原样带上(回了就是它的原话;不经模型)。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SendToClientInput, SendToClientResult } from '../src/server/dispatchSend.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { relayIntoNewConversation } from '../src/server/relayNewConversation.ts'
import {
  createEngineRelayReader,
  createRelayWatchService,
  relayCallNoteOf,
  relayLedgerLineOf,
  sanitizeRelayWatchFile,
  type RelayWait,
} from '../src/server/relayWatch.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

const T0 = Date.parse('2026-09-30T11:50:00.000Z')

function sent(status: 'sent' | 'typed', extra: Partial<SendToClientResult> = {}): SendToClientResult {
  return {
    ok: true,
    dispatch: { hand: 'window', family: 'doubao', status, at: new Date(T0).toISOString(), text: '帮我总结一下这周的选题' },
    bundle_id: 'com.work.pc.doubao',
    ...extra,
  }
}

function harness(result: SendToClientResult, options: { watch?: 'ok' | 'throws' | 'absent' } = {}) {
  const sends: SendToClientInput[] = []
  const remembered: Record<string, unknown>[] = []
  const watch = options.watch ?? 'ok'
  const run = () => relayIntoNewConversation({
    send: async (input) => { sends.push(input); return result },
    ...(watch === 'absent' ? {} : {
      watch: {
        remember: async (input) => {
          if (watch === 'throws') throw new Error('落不了盘')
          remembered.push(input)
          return { id: 'r-1', ...input, at: new Date(T0).toISOString(), state: 'waiting' } as RelayWait
        },
      },
    }),
    newId: () => 'n-0930',
  /*
   * ★ 2026-10-04(卡 `claude/relay-call-optin` → `claude/relay-nocall-noread`):`callOnReply: true`
   * —— 回电从此是**勾了才有**(电话里 = 她明说「回了打给我」),没明说的那一句**一条都不登记**
   * (不盯、不读)。这一份钉的是回电那一套,所以这里照勾上的那一路跑。
   */
  }, { family: 'doubao', title: '豆包', text: '帮我总结一下这周的选题', from: 'call', callOnReply: true })
  return { run, sends, remembered }
}

describe('② 新开一条:投递那一步三档说实话,盯没盯上也说实话', () => {
  it('★核上了(sent):登记回电,记下真送进去的包;回 ok 并说回了会打电话', async () => {
    const h = harness(sent('sent'))
    const got = await h.run()
    expect(got.ok).toBe(true)
    expect(got.delivered).toBe('sent')
    expect(got.watched).toBe(true)
    expect(got.note).toContain('它回了我打电话告诉你')
    expect(h.sends[0]).toMatchObject({ family: 'doubao', newConversation: true, submit: true, confirmMarker: '帮我总结一下这周的选题' })
    // 轻账上没有「要不要回电」那一格了(2026-10-04 下午,卡 `claude/relay-nocall-noread`):
    // 不勾的那一句压根不登记,所以进了这本账的每一条都是她要那一通。
    expect(h.remembered).toEqual([{ agent: 'doubao', session_id: 'n-0930', session_placeholder: true, title: '新会话', mark: '帮我总结一下这周的选题', from: 'call', bundle_id: 'com.work.pc.doubao' }])
  })

  it('★按了发送、对话区没当场核上(typed):**照样登记回电**、回 ok,如实说没看见它收下、别重发', async () => {
    const h = harness(sent('typed', { ok: true }))
    const got = await h.run()
    expect(got.ok).toBe(true)
    expect(got.delivered).toBe('unconfirmed')
    expect(got.watched).toBe(true)
    expect(got.note).toContain('还没在它对话区里看到')
    expect(got.note).toContain('别重发')
    expect(got.note).toContain('打电话')
    expect(got.note).not.toContain('没发出去')
    expect(h.remembered[0]).toMatchObject({ unconfirmed: true, bundle_id: 'com.work.pc.doubao' })
  })

  it('★真没发出去:ok:false,明说「没发出去」和原因;一条回电都不登记', async () => {
    const h = harness({ ok: false, reason: '工作台 App 未运行(送话要经过窗口编排壳)', kind: 'helper_down' })
    const got = await h.run()
    expect(got.ok).toBe(false)
    expect(got.delivered).toBe('failed')
    expect(got.watched).toBe(false)
    expect(got.note).toBe('这句话没发出去:工作台 App 未运行(送话要经过窗口编排壳)')
    expect(h.remembered).toEqual([])
  })

  it('原因里已经说了没送出去的,不再叠一遍', async () => {
    const got = await harness({ ok: false, reason: '这台电脑上还没接上 doubao,这句话没送出去' }).run()
    expect(got.note).toBe('这台电脑上还没接上 doubao,这句话没送出去')
  })

  it('壳回了失败的记录(dispatch.status=failed)也按失败算', async () => {
    const got = await harness({ ok: true, dispatch: { hand: 'window', family: 'doubao', status: 'failed', at: 'x', text: 'y', reason: '输入框找不到' } }).run()
    expect(got.ok).toBe(false)
    expect(got.note).toContain('没发出去')
  })

  it('★发出去了、可回电登记不上(跟踪服务没接 / 落不了盘):明说「不会自己打电话」', async () => {
    for (const watch of ['absent', 'throws'] as const) {
      const got = await harness(sent('sent'), { watch }).run()
      expect(got.ok).toBe(true)
      expect(got.watched).toBe(false)
      expect(got.note).toContain('回电没登记上')
      expect(got.note).toContain('不会自己打电话')
    }
    const typed = await harness(sent('typed'), { watch: 'absent' }).run()
    expect(typed.note).toContain('回电也没登记上')
  })

  it('两个同名 App 时说清派给了哪一个(package_note 带上)', async () => {
    const got = await harness(sent('sent', { package_note: '你这台电脑上装着两个豆包,这次派给的是「豆包工作」那一个' })).run()
    expect(got.note).toContain('「豆包工作」那一个')
  })
})

describe('① 真的那本轻账落不了盘时,这条链路自己就说得出「没登记上」(2026-09-30 止血)', () => {
  it('★不是假的 watch 抛,是**真台账**写不进去:relayIntoNewConversation 回 watched:false,不许说「我盯着」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-relay-chain-'))
    dirs.push(dir)
    // 父级是个普通文件 → 台账那个目录永远建不出来。
    writeFileSync(join(dir, 'blocked'), 'x', 'utf8')
    const watch = createRelayWatchService({
      file: join(dir, 'blocked', 'relay.json'),
      reader: { read: async () => ({ found: false, busy: false, text: '' }) },
      now: () => T0,
      pollMs: 0,
    })
    await watch.load()
    const got = await relayIntoNewConversation({
      send: async () => sent('sent'),
      watch,
      newId: () => 'n-0930',
    /*
   * ★ 2026-10-04(卡 `claude/relay-call-optin` → `claude/relay-nocall-noread`):`callOnReply: true`
   * —— 回电从此是**勾了才有**(电话里 = 她明说「回了打给我」),没明说的那一句**一条都不登记**
   * (不盯、不读)。这一份钉的是回电那一套,所以这里照勾上的那一路跑。
   */
  }, { family: 'doubao', title: '豆包', text: '帮我总结一下这周的选题', from: 'call', callOnReply: true })
    expect(got.ok).toBe(true)
    expect(got.watched).toBe(false)
    expect(got.note).toContain('回电没登记上')
    expect(got.note).not.toContain('它回了我打电话告诉你')
  })
})

describe('③ 盯的时候按真送进去的那个包读窗', () => {
  it('★轻账记了包 → 读窗用它,不再按家名去查(两个豆包时查到的是主包那扇窗)', async () => {
    /*
     * ★ 2026-10-02:读那一眼走 `engine.read`(与派活盯窗同一处)。轻账上那个包原样交给引擎
     * (`Job.package`)—— 窗口适配器「她点名了哪个包就不换」,于是读的一定是那一扇。
     */
    const h = engineHarness({
      // 家族目录按装机挑会挑到主包;轻账记的是办公那个 —— 这一条守的就是「按轻账的,不按家名的」。
      installed: () => [
        { bundle_id: 'com.bot.pc.doubao', name: '豆包', running: true },
        { bundle_id: 'com.work.pc.doubao', name: '豆包工作', running: true },
      ],
      reply: () => ({ found: false }),
    })
    const read = createEngineRelayReader({ engine: h.engine })
    await read.read({ agent: 'doubao', sessionId: 'n-0930', mark: '帮我总结一下这周的选题', bundleId: 'com.work.pc.doubao' })
    expect(h.requests[0]).toMatchObject({ op: 'read_reply', bundle_id: 'com.work.pc.doubao' })
  })

  it('巡检把轻账上的包交给读窗那一只手', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-relay-chain-'))
    dirs.push(dir)
    const asked: unknown[] = []
    const service = createRelayWatchService({
      file: join(dir, 'relay.json'),
      reader: { read: async (req) => { asked.push(req); return { found: false, busy: false, text: '' } } },
      now: () => T0,
      pollMs: 0,
    })
    await service.load()
    await service.remember({ agent: 'doubao', session_id: 'n-0930', session_placeholder: true, title: '新会话', mark: '帮我总结', from: 'call', bundle_id: 'com.work.pc.doubao', unconfirmed: true })
    await service.pump()
    // 巡检交下去的那几格:账上这一条的 id(占位那一条键用它)+ 真送进去的那个包。
    expect(asked).toEqual([{ agent: 'doubao', sessionId: 'n-0930', mark: '帮我总结', waitId: service.list()[0]?.id, placeholder: true, bundleId: 'com.work.pc.doubao' }])
    expect(service.list()[0]).toMatchObject({ bundle_id: 'com.work.pc.doubao', unconfirmed: true })
  })

  it('轻账跨重启:包与「没核上」两格读得回来,乱写的丢掉', () => {
    const file = sanitizeRelayWatchFile({
      version: 1,
      waits: [
        { id: 'r-a', agent: 'doubao', session_id: 's', mark: 'm', at: 'x', from: 'call', state: 'waiting', bundle_id: 'com.work.pc.doubao', unconfirmed: true },
        { id: 'r-b', agent: 'doubao', session_id: 's', mark: 'm', at: 'x', from: 'call', state: 'waiting', bundle_id: 3, unconfirmed: 'yes' },
      ],
    })
    expect(file.waits[0]).toMatchObject({ bundle_id: 'com.work.pc.doubao', unconfirmed: true })
    expect(file.waits[1]).not.toHaveProperty('bundle_id')
    expect(file.waits[1]).not.toHaveProperty('unconfirmed')
  })
})

function wait(patch: Partial<RelayWait> = {}): RelayWait {
  return {
    id: 'r-1', agent: 'doubao', session_id: 'n-0930', session_placeholder: true, title: '新会话', mark: '帮我总结一下这周的选题',
    at: new Date(T0).toISOString(), from: 'call', state: 'waiting', ...patch,
  }
}

describe('③ 等过头时的回电:没核上的那条明说没核实到发出去', () => {
  it('★没核上、一直没读到:说「没在它对话区里看到这句话」「可能没发出去」,不说成「它还没回」', () => {
    const note = relayCallNoteOf(wait({ state: 'timeout', unconfirmed: true }), T0 + 20 * 60_000)
    expect(note).toContain('没在它对话区里看到这句话')
    expect(note).toContain('可能没发出去')
    expect(note).not.toContain('它还没回')
  })

  it('核上了的那条等过头:照旧说还没回', () => {
    expect(relayCallNoteOf(wait({ state: 'timeout' }), T0 + 20 * 60_000)).toContain('它还没回')
  })
})

describe('③ 电话里「看一眼」:捎话账上那一条原样带上', () => {
  const now = T0 + 3 * 60_000
  const isDoubao = (agent: string) => agent === 'doubao'

  it('★回了:带它的原话(不经模型),说是几分钟前捎进去的', () => {
    const line = relayLedgerLineOf([wait({ state: 'replied', reply: '这周三个选题:秋季护肤、通勤穿搭、露营。' })], isDoubao, now)
    expect(line).toContain('3 分钟前')
    expect(line).toContain('它的原话:这周三个选题:秋季护肤、通勤穿搭、露营。')
  })

  it('还在等:说还没读到回话、在盯着;没核上的加一句没看见它收下', () => {
    expect(relayLedgerLineOf([wait()], isDoubao, now)).toContain('还没读到它回话')
    expect(relayLedgerLineOf([wait({ unconfirmed: true })], isDoubao, now)).toContain('没在它对话区里看见')
  })

  it('等过头了:如实说一直没读到', () => {
    expect(relayLedgerLineOf([wait({ state: 'timeout' })], isDoubao, now)).toContain('一直没读到它回话')
  })

  it('只看这一家的、最近那一条;3 小时之前的不算;没有就 undefined', () => {
    const old = wait({ id: 'r-0', state: 'replied', reply: '老的', at: new Date(T0 - 4 * 3600_000).toISOString() })
    const other = wait({ id: 'r-2', agent: 'claude', state: 'replied', reply: '别家的' })
    expect(relayLedgerLineOf([old], isDoubao, now)).toBeUndefined()
    expect(relayLedgerLineOf([other], isDoubao, now)).toBeUndefined()
    const newer = wait({ id: 'r-3', state: 'replied', reply: '新的', at: new Date(T0 + 60_000).toISOString() })
    expect(relayLedgerLineOf([wait({ state: 'replied', reply: '早一点的' }), newer, other], isDoubao, now)).toContain('新的')
  })
})
