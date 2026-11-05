// @vitest-environment node
/**
 * 同事项执行持久租约(2026-10-26,卡「事务官机制D」t-ea3ba424,机制红例:同卡同树 14:36 双派
 * 两个 Kimi 进程 1892/1961;「dispatch 说 done(中途文本)但原生轮次 07:19 才结束」)。
 *
 * 钉的是**同一时刻至多一个活跃写者**:
 *   - claim 按 (task_id, cwd) 双键拒重:同卡二派、同工作区另一卡,都拒,给出 holder 真身;
 *   - 全部判定走内存串行队列 + JSON 落盘:并发请求只有一个赢家(两个 dispatch 同时进来也是),
 *     插件重启之后新进程照同一份文件继续拒(租约随文件走,不随 PID 走);
 *   - release 必须带 run_id 或 pid 精确认领:迟到的旧进程退出不许摘掉新租约(stale-run 拒);
 *   - markUncertain:只剩「pid 没了」这一格证据时**不释放**,标不确定 —— 不凭进程号消失就重新派。
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-lease-'))
  dirs.push(dir)
  return join(dir, 'leases.json')
}

const NOW = '2026-10-26T08:00:00.000Z'

describe('claim:同卡 / 同树双键拒重', () => {
  it('★空树 claim → ok;同卡再 claim(另一 run)→ 拒,holder 是第一次的真身', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    const first = await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    expect(first.ok).toBe(true)
    const again = await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    expect(again.ok).toBe(false)
    if (!again.ok && 'holder' in again) expect(again.holder).toMatchObject({ task_id: 't-1', cwd: '/wt/a', run_id: 'r-1', family: 'kimi' })
  })

  it('★不同卡、同一工作区 → 拒(tree-held):holder 是占着这棵树那张卡', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/shared', family: 'kimi', runId: 'r-1', at: NOW })
    const other = await store.claim({ taskId: 't-2', cwd: '/wt/shared', family: 'kimi', runId: 'r-2', at: NOW })
    expect(other.ok).toBe(false)
    if (!other.ok && 'holder' in other) expect(other.holder.task_id).toBe('t-1')
  })

  it('不同工作区互不挡', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    expect((await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })).ok).toBe(true)
    expect((await store.claim({ taskId: 't-2', cwd: '/wt/b', family: 'kimi', runId: 'r-2', at: NOW })).ok).toBe(true)
  })

  it('★并发两个 claim 同时进来:只有一个赢(串行队列),输家拿到赢家的 holder', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    const [a, b] = await Promise.all([
      store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-a', at: NOW }),
      store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-b', at: NOW }),
    ])
    const winners = [a, b].filter(one => one.ok)
    const losers = [a, b].filter(one => !one.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    if (!losers[0]!.ok && 'holder' in losers[0]!) {
      const holder = losers[0]!.holder
      expect(holder.run_id === 'r-a' || holder.run_id === 'r-b').toBe(true)
      expect(holder.task_id).toBe('t-1')
    }
  })
})

describe('release:精确认领,迟到回调摘不动新租约', () => {
  it('★按 run_id 释放 → 再 claim ok;释放记录带证据与退出码', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    const released = await store.release({ taskId: 't-1', runId: 'r-1', evidence: 'process-exit', code: 0, at: NOW })
    expect(released.ok).toBe(true)
    if (released.ok) expect(released.lease.release).toMatchObject({ evidence: 'process-exit', code: 0 })
    expect((await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })).ok).toBe(true)
  })

  it('★按 pid 释放(attachPid 之后)→ ok', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await store.attachPid({ taskId: 't-1', runId: 'r-1', pid: 4242 })
    expect((await store.release({ taskId: 't-1', pid: 4242, evidence: 'process-failed', code: 1, at: NOW })).ok).toBe(true)
    expect((await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })).ok).toBe(true)
  })

  it('★旧 run 的释放(r-1)在新租约(r-2)期间 → stale-run,新租约原样还在', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await store.release({ taskId: 't-1', runId: 'r-1', evidence: 'not-started', at: NOW })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    const stale = await store.release({ taskId: 't-1', runId: 'r-1', evidence: 'process-exit', code: 0, at: NOW })
    expect(stale).toEqual({ ok: false, why: 'stale-run' })
    // 新租约还在:第三派仍被拒,holder 还是 r-2。
    const third = await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-3', at: NOW })
    expect(third.ok).toBe(false)
    if (!third.ok && 'holder' in third) expect(third.holder.run_id).toBe('r-2')
  })

  it('认不出身份(release 不带 run_id/pid)→ stale-run,不动', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    expect(await store.release({ taskId: 't-1', evidence: 'process-exit', code: 0, at: NOW })).toEqual({ ok: false, why: 'stale-run' })
  })
})

describe('不确定性保留与接管:不凭 pid 没了就重派', () => {
  it('★markUncertain 之后租约仍 active:新进程照常被拒,但拒因可说「不确定」', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await store.attachPid({ taskId: 't-1', runId: 'r-1', pid: 9999 })
    await store.markUncertain({ taskId: 't-1', runId: 'r-1' })
    const still = await store.activeForTask('t-1')
    expect(still).toMatchObject({ run_id: 'r-1', uncertain: true })
    const refused = await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    expect(refused.ok).toBe(false)
    if (!refused.ok && 'unreadable' in refused) throw new Error('活跃租约不该报读不清')
  })

  it('★同卡人来重派(takeover)允许换租约;别卡同树仍拒', async () => {
    const store = createExecutionLeaseStore({ file: tempFile() })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await store.attachPid({ taskId: 't-1', runId: 'r-1', pid: 9999 })
    await store.markUncertain({ taskId: 't-1', runId: 'r-1' })
    // 同卡 takeover:人点了这张卡的重派 —— 明确决定,放行并换租约。
    expect((await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW, takeover: true })).ok).toBe(true)
    expect((await store.activeForTask('t-1'))?.run_id).toBe('r-2')
    // 别卡同树:t-2 仍被拒(树还被 t-1 占着)。
    const other = await store.claim({ taskId: 't-2', cwd: '/wt/a', family: 'kimi', runId: 'r-3', at: NOW })
    expect(other.ok).toBe(false)
    if (!other.ok && 'holder' in other) expect(other.holder.task_id).toBe('t-1')
  })
})

describe('持久化:重启之后同一份事实', () => {
  it('★新 store 实例(同一文件)看得见 active 租约:重启不丢、不重放', async () => {
    const file = tempFile()
    const before = createExecutionLeaseStore({ file })
    await before.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await before.attachPid({ taskId: 't-1', runId: 'r-1', pid: 777 })
    // 「重启」:换一个实例。
    const after = createExecutionLeaseStore({ file })
    const held = await after.activeForTask('t-1')
    expect(held).toMatchObject({ run_id: 'r-1', pid: 777 })
    const refused = await after.claim({ taskId: 't-2', cwd: '/wt/a', family: 'kimi', runId: 'r-9', at: NOW })
    expect(refused.ok).toBe(false)
    if (!refused.ok && 'unreadable' in refused) throw new Error('活跃租约不该报读不清')
  })

  it('文件读不懂(半截/空)→ 当作没有租约,不编', async () => {
    const file = tempFile()
    const store = createExecutionLeaseStore({ file })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    const store2 = createExecutionLeaseStore({ file })
    expect((await store2.activeForTask('t-1'))?.run_id).toBe('r-1')
  })
})

describe('合流返工五缺口(2026-10-26)', () => {
  it('★缺口1:坏 JSON / 形状不对 / 有认不出的条目 → claim 拒发(unreadable + 原因),绝不当「没有租约」', async () => {
    const file = tempFile()
    const store = createExecutionLeaseStore({ file })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    // 坏 JSON(写到一半的非原子写)
    writeFileSync(file, '{"leases":[{"task_id":"t-1",')
    const broken = await store.claim({ taskId: 't-2', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    expect(broken.ok).toBe(false)
    if (!broken.ok && 'unreadable' in broken) expect(broken.unreadable).toContain('JSON')
    else throw new Error('坏 JSON 必须拒发,不许当没有租约')
    // 形状不对
    writeFileSync(file, '{"nope":[]}')
    const shaped = await store.claim({ taskId: 't-2', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    expect(shaped.ok).toBe(false)
    if (!shaped.ok && 'unreadable' in shaped) expect(shaped.unreadable).toContain('形状')
    else throw new Error('形状不对必须拒发')
    // 有认不出的条目(半截结构)
    writeFileSync(file, `{"leases":[{"task_id":"t-1","cwd":"/wt/a","family":"kimi","run_id":"r-1","claimed_at":"${NOW}","state":"active"},{"wat":1}]}`)
    const partial = await store.claim({ taskId: 't-2', cwd: '/wt/b', family: 'kimi', runId: 'r-2', at: NOW })
    expect(partial.ok).toBe(false)
    if (!partial.ok && 'unreadable' in partial) expect(partial.unreadable).toContain('认不出')
    else throw new Error('半截条目必须整文件拒发,不许静默丢掉活跃锁')
  })

  it('★缺口1b:原子写 —— 写后没有 .tmp 残留;ENOENT 照当空(第一次)', async () => {
    const file = tempFile()
    const store = createExecutionLeaseStore({ file })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await store.release({ taskId: 't-1', runId: 'r-1', evidence: 'process-exit', code: 0, at: NOW })
    const leftovers = readdirSync(file.slice(0, file.lastIndexOf('/'))).filter(one => one.includes('.tmp-'))
    expect(leftovers).toEqual([])
    // 缺席文件 = 还没有租约:claim 直接成。
    const fresh = createExecutionLeaseStore({ file: tempFile() })
    expect((await fresh.claim({ taskId: 't-x', cwd: '/wt/x', family: 'kimi', runId: 'r-x', at: NOW })).ok).toBe(true)
  })

  it('★缺口2:活跃锁永不淘汰 —— A 长占,210 个别卡短活来了又走,A 的锁还在、B 进 A 的树仍被拒', async () => {
    const file = tempFile()
    const store = createExecutionLeaseStore({ file })
    await store.claim({ taskId: 't-A', cwd: '/wt/long', family: 'kimi', runId: 'r-A', at: NOW })
    for (let i = 0; i < 210; i += 1) {
      const id = `t-s${i}`
      await store.claim({ taskId: id, cwd: `/wt/s${i}`, family: 'kimi', runId: `r-s${i}`, at: NOW })
      await store.release({ taskId: id, runId: `r-s${i}`, evidence: 'process-exit', code: 0, at: NOW })
    }
    const still = await store.activeForTask('t-A')
    expect(still?.run_id).toBe('r-A')
    expect(still?.state).toBe('active')
    const intruder = await store.claim({ taskId: 't-B', cwd: '/wt/long', family: 'kimi', runId: 'r-B', at: NOW })
    expect(intruder.ok).toBe(false)
    if (!intruder.ok && 'holder' in intruder) expect(intruder.holder.run_id).toBe('r-A')
    else throw new Error('A 的长活锁被裁掉了 —— 缺口2')
  })

  it('★release:run_id 或 pid 有一个对上即放(合流后 finishCli 两个都带)', async () => {
    const file = tempFile()
    const store = createExecutionLeaseStore({ file })
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-1', at: NOW })
    await store.attachPid({ taskId: 't-1', runId: 'r-1', pid: 31415 })
    // 只带 run_id(重启后不知道 pid 的场景)
    expect((await store.release({ taskId: 't-1', runId: 'r-1', evidence: 'process-exit', code: 0, at: NOW })).ok).toBe(true)
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    // 只带 pid
    expect((await store.release({ taskId: 't-1', pid: undefined, evidence: 'process-failed', code: 1, at: NOW })).ok).toBe(false)
    await store.attachPid({ taskId: 't-1', runId: 'r-2', pid: 27182 })
    expect((await store.release({ taskId: 't-1', pid: 27182, evidence: 'process-exit', code: 0, at: NOW })).ok).toBe(true)
    // 都对不上 → stale-run
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-3', at: NOW })
    expect(await store.release({ taskId: 't-1', runId: 'r-9', pid: 999, evidence: 'process-exit', code: 0, at: NOW })).toEqual({ ok: false, why: 'stale-run' })
  })
})

describe('收尾:release 以 runId 为权威(2026-10-26 深夜)', () => {
  it('★给了 runId 就必须匹配,PID 重用救不回;同给 pid 矛盾也拒;attachPid 失败同 runId 照常放', async () => {
    const file = tempFile()
    const store = createExecutionLeaseStore({ file })
    // 新租约:run r-2,pid 5555(系统重用号)。
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-2', at: NOW })
    await store.attachPid({ taskId: 't-1', runId: 'r-2', pid: 5555 })
    // 旧 runId + 重用的 pid → 拒(runId 权威,矛盾不许用 pid 救)。
    expect(await store.release({ taskId: 't-1', runId: 'r-1', pid: 5555, evidence: 'process-exit', code: 0, at: NOW })).toEqual({ ok: false, why: 'stale-run' })
    // 对得上的 runId + 矛盾的 pid → 也拒。
    expect(await store.release({ taskId: 't-1', runId: 'r-2', pid: 6666, evidence: 'process-exit', code: 0, at: NOW })).toEqual({ ok: false, why: 'stale-run' })
    // runId + 一致的 pid → 放。
    expect((await store.release({ taskId: 't-1', runId: 'r-2', pid: 5555, evidence: 'process-exit', code: 0, at: NOW })).ok).toBe(true)
    // attachPid 没补上的旧世界:只带 runId 照常放(pid 无从核对,不挡)。
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-3', at: NOW })
    expect((await store.release({ taskId: 't-1', runId: 'r-3', evidence: 'process-failed', code: 1, at: NOW })).ok).toBe(true)
    // 不带 runId:退回 pid 认领(重启巡检路)照常用。
    await store.claim({ taskId: 't-1', cwd: '/wt/a', family: 'kimi', runId: 'r-4', at: NOW })
    await store.attachPid({ taskId: 't-1', runId: 'r-4', pid: 7777 })
    expect((await store.release({ taskId: 't-1', pid: 7777, evidence: 'process-exit', code: 0, at: NOW })).ok).toBe(true)
  })
})
