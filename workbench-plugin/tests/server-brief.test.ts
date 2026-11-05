// @vitest-environment node
/**
 * 今晨快报(W4):触发规则纯函数 + 取数/落盘。
 *
 * 规则(Ben 2026-08-25 定,原规则②「额度触底/多会话等确认时并推一次」已去掉——
 * 内容源换成 AiDJ 的 AI 行业资讯后,拿额度触底当推资讯的理由说不通):
 *   ① 当天首次开工推一次  ② 一天最多一次  ③ 用户划走后当天不再推
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBriefService, shouldPushBrief, type BriefFile } from '../src/server/brief.ts'

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'brief-')), 'brief.json')
}

function file(over: Partial<BriefFile> = {}): BriefFile {
  return {
    version: 1, date: '2026-08-25', fetched_at: 0, topics: [], pushed_at: null, dismissed: false,
    last_attempt_at: 0, ...over,
  }
}

const TOPIC = {
  id: 'd1', section: '今日资讯', title: '标题', summary: '摘要',
  url: 'https://example.com/a', source: '某 RSS', tier: 'flash',
}

describe('shouldPushBrief(触发规则,纯函数)', () => {
  it('跨天:重置,推', () => {
    expect(shouldPushBrief(file({ date: '2026-08-24', pushed_at: 1, dismissed: true }), '2026-08-25')).toBe(true)
  })
  it('当天首次:推', () => {
    expect(shouldPushBrief(file(), '2026-08-25')).toBe(true)
  })
  it('当天已推过:不再推(一天最多一次)', () => {
    expect(shouldPushBrief(file({ pushed_at: 1 }), '2026-08-25')).toBe(false)
  })
  it('当天已划走:不再推,哪怕还没推过', () => {
    expect(shouldPushBrief(file({ dismissed: true }), '2026-08-25')).toBe(false)
  })
})

describe('createBriefService', () => {
  it('取到数据:落盘并投影出 topics 与 push:true', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ date: '2026-08-25', status: 'ready', topics: [TOPIC], segments: [] }),
    })) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    const view = await brief.view()
    expect(view?.topics).toHaveLength(1)
    expect(view?.push).toBe(true)
    expect(view?.error).toBeUndefined()
    const saved = JSON.parse(await readFile(f, 'utf8')) as BriefFile
    expect(saved.topics).toHaveLength(1)
  })

  it('status 不是 ready:不推、不摆空壳,topics 为空', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ date: '2026-08-25', status: 'empty', topics: [], segments: [] }),
    })) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    const view = await brief.view()
    expect(view?.topics).toEqual([])
    expect(view?.push).toBe(false)
  })

  it('取数失败:如实带 error,绝不推、绝不拿昨天的冒充今天', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => { throw new Error('连不上') }) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    const view = await brief.view()
    expect(view?.push).toBe(false)
    expect(view?.error).toContain('连不上')
    expect(view?.topics).toEqual([])
  })

  /**
   * 终审 C3:这条用例原来的标题写着"手动展开仍看得到"——那是把服务端的"内容没被清空"
   * 直接当成了"界面上还看得见",而客户端在 dismissed 时已经整块不渲染了(见
   * Butler.tsx 的渲染条件)。标题按代码的真实行为改写:留在投影里的是内容本身
   * (不清空,跨天才重置),看不看得见由 dismissed 决定。
   */
  it('划走之后当天不再推,topics 也不清空(跨天才重置)', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ date: '2026-08-25', status: 'ready', topics: [TOPIC], segments: [] }),
    })) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    await brief.view()
    await brief.dismiss()
    const view = await brief.view()
    expect(view?.push).toBe(false)
    expect(view?.topics).toHaveLength(1)
  })

  /**
   * 终审 C3(合并前必修):`dismissed` 必须投影进 BriefView。
   *
   * 在此之前它只活在服务端的 brief.json 里,客户端拿不到——点 ✕ 之后服务端确实记下了
   * dismissed:true,可下一拍 /state 回来的 topics 一条不少,界面纹丝不动。按钮的
   * aria-label 写着「划走今晨快报」,却划不走任何东西(踩红线:界面不得声称工作台
   * 做不到的事)。**不能拿 push 当渲染开关**——它是一次性的(当天第一次算出 true
   * 之后就写 pushed_at,下一拍立刻变 false),那样快报会在一秒后自己消失。
   */
  it('C3:划走之后 view() 投影出 dismissed:true;没划走时不带这个字段(缺省即无)', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ date: '2026-08-25', status: 'ready', topics: [TOPIC], segments: [] }),
    })) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    expect((await brief.view())?.dismissed).toBeUndefined()
    await brief.dismiss()
    expect((await brief.view())?.dismissed).toBe(true)
  })

  it('同一天内不重复打上游接口(有当天缓存就用缓存)', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ date: '2026-08-25', status: 'ready', topics: [TOPIC], segments: [] }),
    })) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    await brief.view()
    await brief.view()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('取数失败后 60 秒内不重试——1s 轮询不该把上游打爆', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => { throw new Error('连不上') }) as unknown as typeof fetch
    let t = Date.parse('2026-08-25T09:00:00+08:00')
    const brief = createBriefService({ file: f, fetchImpl, now: () => t })

    await brief.view()
    t += 1000
    await brief.view()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    t += 60_000
    await brief.view()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  // 评审修复轮 1(Critical):view()/dismiss() 是 load→改→save,并发下没有互斥,
  // 两个客户端(壳内 WKWebView + 浏览器标签)在同一 1s 轮询 tick 附近各自读到
  // pushed_at:null 就会各自算出 push:true、各自写回,同一天推两次——写队列修的就是这个。
  it('并发 view():只有一次 push:true(写队列防止竞态)', async () => {
    const f = await tmpFile()
    // 直接落一份"已经取到、还没推过"的存档,跳过取数分支,单独隔离写竞态本身,
    // 不让取数的网络时延给这条并发断言引入无关的时序不确定性。
    await writeFile(f, JSON.stringify({
      version: 1, date: '2026-08-25', fetched_at: 1, topics: [TOPIC], pushed_at: null, dismissed: false,
      last_attempt_at: 0,
    }))
    const fetchImpl = vi.fn(async () => { throw new Error('不该调用到这里——fetched_at 已非 0') }) as unknown as typeof fetch
    const brief = createBriefService({ file: f, fetchImpl, now: () => Date.parse('2026-08-25T09:00:00+08:00') })

    // 故意不等第一个 view() 落定就发第二个——制造两个 /state 轮询在同一 tick 附近到达的时序。
    const [a, b] = await Promise.all([brief.view(), brief.view()])
    const pushedCount = [a?.push, b?.push].filter(p => p === true).length
    expect(pushedCount).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // 评审修复轮 1(Important):节流状态若只存进程内闭包,进程重启(含 crash-loop)
  // 会让新实例的内存清零,下一拍立刻无视 60s 窗口再打上游——这条测试模拟"重启"
  // (同一份文件、全新实例),确认节流跨实例存活。
  it('取数失败节流跨"进程重启"存活——落盘的节流状态不会被新实例的内存清零绕过', async () => {
    const f = await tmpFile()
    const fetchImpl = vi.fn(async () => { throw new Error('连不上') }) as unknown as typeof fetch
    const t0 = Date.parse('2026-08-25T09:00:00+08:00')

    const briefA = createBriefService({ file: f, fetchImpl, now: () => t0 })
    await briefA.view() // 第一次失败尝试,理应把节流状态落盘

    // 模拟进程重启:同一份文件路径,全新实例——新实例的内存节流变量从 0 开始。
    const t1 = t0 + 1000 // 才过 1 秒,远没到 60s
    const briefB = createBriefService({ file: f, fetchImpl, now: () => t1 })
    await briefB.view()
    expect(fetchImpl).toHaveBeenCalledTimes(1) // 没有因为换了实例就重试

    const t2 = t0 + 60_000 // 60s 过后,新实例照常能重试
    const briefC = createBriefService({ file: f, fetchImpl, now: () => t2 })
    await briefC.view()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
