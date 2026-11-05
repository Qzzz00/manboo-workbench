// @vitest-environment node
/**
 * 「设置模型变更 → 同一事务官入口继续说话」(2026-10-23 运行时 P1,真实 DSH + 本地假 OpenAI 复现):
 *
 *   /butler/item 开会话用模型 A → PUT /model 只改成 B → 同一入口再说一句。
 *   旧会话钉在 (workbench-own, A) 上,而 workbench-own 的 catalog 已被重写成只有 B →
 *   DSH turn/end 报 UNKNOWN_MODEL,第二轮一个上游请求都没有(carryOnTarget 复用了旧会话)。
 *
 * 修法(读上游源码定的):DSH `sessionController.selectModel` 支持给**已在跑的会话**换模型
 * (上游 `packages/api/session-controller/src/commands.ts`:requireModel 校验 →
 * selectForNextRequest → 下一条请求生效)。所以模型设置一变,把「受这份设置控制」的会话
 * (钉在我们维护的路由 workbench-relay / workbench-own 上的;以及官方 provider 上、
 * 正用被换掉的那个模型名的)重指到新目标 —— 保留会话上下文,不新建会话,
 * 也不靠把旧模型留在 catalog 里让它悄悄继续用旧模型。
 *
 * 这里全部用假 controller / 假 opener,不碰真 DSH。
 */
import { describe, expect, it, vi } from 'vitest'
import { isSettingControlledSession, needsAlign, planModelRetargets, retargetManagedSessions } from '../src/server/modelRetarget.ts'
import { createButlerSessionOpener } from '../src/index.ts'

describe('planModelRetargets:哪些会话该重指', () => {
  const sessions = [
    { sessionId: 's-own', provider: 'workbench-own', model: 'qa-brain-a' },
    { sessionId: 's-relay', provider: 'workbench-relay', model: 'deepseek-v4-flash' },
    { sessionId: 's-official-old', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    { sessionId: 's-official-other', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { sessionId: 's-unknown' },
  ]

  it('★钉在我们维护的路由上的会话一律重指(换 provider 它们当场 UNKNOWN_MODEL)', () => {
    const plan = planModelRetargets(sessions, { provider: 'workbench-own', model: 'qa-brain-b' }, undefined)
    expect(plan).toEqual([
      { sessionId: 's-own', provider: 'workbench-own', model: 'qa-brain-b' },
      { sessionId: 's-relay', provider: 'workbench-own', model: 'qa-brain-b' },
    ])
  })

  it('「只换模型名」那一场:官方 provider 上正用被换掉的那个模型名的会话也跟着换', () => {
    const plan = planModelRetargets(
      sessions,
      { provider: 'deepseek-official', model: 'my-finetune-1', prevModel: 'deepseek-v4-flash-vision-exp' },
      undefined,
    )
    expect(plan).toEqual([
      { sessionId: 's-own', provider: 'deepseek-official', model: 'my-finetune-1' },
      { sessionId: 's-relay', provider: 'deepseek-official', model: 'my-finetune-1' },
      { sessionId: 's-official-old', provider: 'deepseek-official', model: 'my-finetune-1' },
    ])
  })

  it('模型名不是被换掉的那个、provider 也不是受控路由的:一个字不动', () => {
    const plan = planModelRetargets(
      sessions,
      { provider: 'deepseek-official', model: 'my-finetune-1', prevModel: 'deepseek-v4-flash-vision-exp' },
      undefined,
    )
    expect(plan.some(one => one.sessionId === 's-official-other')).toBe(false)
    expect(plan.some(one => one.sessionId === 's-unknown')).toBe(false)
  })

  it('目标没有模型名时问 catalog 缺省;问不到就跳过,不猜一个模型名', () => {
    // 切到中转:目标模型名由 catalog 缺省(= agent-default-model,他选的那个)补。
    const withFallback = planModelRetargets(sessions, { provider: 'workbench-relay' }, { provider: 'workbench-relay', model: 'deepseek-v4-flash-vision-exp' })
    expect(withFallback).toContainEqual({ sessionId: 's-own', provider: 'workbench-relay', model: 'deepseek-v4-flash-vision-exp' })
    // 问不到 catalog:不猜,一条都不动。
    expect(planModelRetargets(sessions, { provider: 'workbench-relay' }, undefined)).toEqual([])
  })

  it('已经在目标上的会话不重复指', () => {
    const plan = planModelRetargets(
      [{ sessionId: 's-own', provider: 'workbench-own', model: 'qa-brain-b' }],
      { provider: 'workbench-own', model: 'qa-brain-b' },
      undefined,
    )
    expect(plan).toEqual([])
  })
})

describe('retargetManagedSessions:编排(模型设置变更那一刻)', () => {
  it('枚举在册会话 → 按 plan 逐条 retarget;opener 缺席/没有 retarget 口就安静退出', async () => {
    const retargeted: { sessionId: string, provider: string, model: string }[] = []
    const opener = {
      open: async () => undefined,
      catalog: async () => ({ default: { provider: 'workbench-own', model: 'qa-brain-b', title: 'B', images: false }, models: [] }),
      retarget: async (sessionId: string, provider: string, model: string) => {
        retargeted.push({ sessionId, provider, model })
        return true
      },
    }
    const deps = {
      selections: async () => [
        { sessionId: 's-own', provider: 'workbench-own', model: 'qa-brain-a' },
        { sessionId: 's-his', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      ],
      opener: { retarget: opener.retarget },
      change: { provider: 'workbench-own', model: 'qa-brain-b' },
    }
    await retargetManagedSessions(deps)
    expect(retargeted).toEqual([{ sessionId: 's-own', provider: 'workbench-own', model: 'qa-brain-b' }])
    // opener 缺少必需的 retarget 能力：向设置传播失败。
    await expect(retargetManagedSessions({ ...deps, opener: {} })).rejects.toThrow('MODEL_SELECTION_UNAVAILABLE')
    // catalog 问不到、change 也没有模型名:跳过,不猜。
    await retargetManagedSessions({
      ...deps,
      opener: { retarget: opener.retarget },
      change: { provider: 'workbench-relay' },
    })
    expect(retargeted).toHaveLength(1)
  })
})

describe('createButlerSessionOpener.retarget:走 DSH selectModel', () => {
  function makeOpener(selectModel: (request: unknown) => Promise<unknown>) {
    return createButlerSessionOpener({
      on: () => undefined,
      inject: (services: readonly string[], cb: (ctx: never) => void) => {
        if (services[0] === 'sessionController') {
          cb({ sessionController: { selectModel, create: async () => ({ sessionId: 'x' }), prompt: async () => undefined } } as never)
        }
      },
    } as never, () => undefined)
  }

  it('对一条已在跑的会话调 selectModel(provider/model),成功回 true', async () => {
    const selectModel = vi.fn(async () => ({ selected: { provider: 'workbench-own', model: 'qa-brain-b' } }))
    const opener = makeOpener(selectModel as never)
    expect(opener?.retarget).toBeDefined()
    const ok = await opener?.retarget?.('s-1', 'workbench-own', 'qa-brain-b')
    expect(ok).toBe(true)
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-1', provider: 'workbench-own', model: 'qa-brain-b' }))
  })

  it('selectModel 抛(模型此刻不可用/会话没了):回 false,不抛', async () => {
    const selectModel = vi.fn(async () => { throw new Error('UNKNOWN_MODEL') })
    const opener = makeOpener(selectModel as never)
    expect(await opener?.retarget?.('s-gone', 'workbench-own', 'qa-brain-b')).toBe(false)
  })
})

describe('needsAlign:说之前这条会话要不要先对齐(竞态闭环,feed 可能是空的)', () => {
  it('钉在受控旧路由上的 → 对齐;已在目标上的 → 不用', () => {
    expect(needsAlign({ provider: 'workbench-own', model: 'qa-brain-a' }, { provider: 'workbench-own', model: 'qa-brain-b' })).toBe(true)
    expect(needsAlign({ provider: 'workbench-relay', model: 'deepseek-v4-flash' }, { provider: 'workbench-own', model: 'qa-brain-b' })).toBe(true)
    expect(needsAlign({ provider: 'workbench-own', model: 'qa-brain-b' }, { provider: 'workbench-own', model: 'qa-brain-b' })).toBe(false)
  })

  it('DSH 重启后 feed 不认识这条会话(undefined):保守对齐 —— carryOnTarget 接历史会话也闭环', () => {
    expect(needsAlign(undefined, { provider: 'workbench-own', model: 'qa-brain-b' })).toBe(true)
  })

  it('「只换模型名」:官方 provider 上正用被换掉的那个名的 → 对齐;用别的名的 → 不动', () => {
    expect(needsAlign(
      { provider: 'deepseek-official', model: 'my-finetune-1' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', prevModel: 'my-finetune-1' },
    )).toBe(true)
    expect(needsAlign(
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', prevModel: 'my-finetune-1' },
    )).toBe(false)
    // target 没带 prevModel(默认官方 / 中转):官方上的会话一律不动。
    expect(needsAlign(
      { provider: 'deepseek-official', model: 'my-finetune-1' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    )).toBe(false)
  })

  it('别的 provider(用户自己配的)上的:不动', () => {
    expect(needsAlign({ provider: 'his-own-gateway', model: 'x' }, { provider: 'workbench-own', model: 'qa-brain-b' })).toBe(false)
  })
})

/**
 * needsAlign 与 planModelRetargets 判据一致(2026-10-23 源审退修):
 * 已直接复现 sel={provider:'deepseek-official',model:'deepseek-flash'}、
 * target={provider:'workbench-own',model:'qa-brain-b',prevModel:'deepseek-flash'}
 * 时 plan 会重指而 needsAlign 返回 false —— 官方 provider 上正用「被换掉的模型名」的会话,
 * 无论是切到 own 还是官方内换名,都必须两边一致地判「受控」。统一到一处判据。
 */
describe('needsAlign 与 plan 判据一致(官方→own,2026-10-23 源审退修)', () => {
  const selOfficial = { sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-flash' }
  const changeToOwn: { provider: string, model: string, prevModel?: string } = { provider: 'workbench-own', model: 'qa-brain-b', prevModel: 'deepseek-flash' }

  it('★官方+被换掉的模型名 → own:needsAlign 与 plan 都判「要动」(复现点,以前 needsAlign 漏掉)', () => {
    expect(needsAlign(selOfficial, changeToOwn)).toBe(true)
    expect(planModelRetargets([selOfficial], changeToOwn, undefined))
      .toEqual([{ sessionId: 's1', provider: 'workbench-own', model: 'qa-brain-b' }])
  })

  it('官方但模型名不是被换掉的那个 → 两边都「不动」(反例)', () => {
    const other = { sessionId: 's2', provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    expect(needsAlign(other, changeToOwn)).toBe(false)
    expect(planModelRetargets([other], changeToOwn, undefined)).toEqual([])
  })

  it('没带 prevModel 的 own 切换:官方上的会话两边都一律不动(他在 DSH 网页自选的不碰)', () => {
    const noPrev: { provider: string, model: string } = { provider: 'workbench-own', model: 'qa-brain-b' }
    expect(needsAlign(selOfficial, noPrev)).toBe(false)
    expect(planModelRetargets([selOfficial], noPrev, undefined)).toEqual([])
  })
})

/**
 * isSettingControlledSession 的官方 provider 边界(2026-10-23 第二轮源审退修):
 * 「正用被换掉的模型名(prevModel)」那一档**必须同时钉死 provider 是 deepseek-official**。
 * 上一版只比 prevModel/model 同名:自配 provider 上恰好也叫这个名字的会话会被
 * needsAlign/plan 误判成受控、被强行搬到 workbench-own —— 自配 provider 不动是卡原要求。
 */
describe('受控判据的官方 provider 边界(2026-10-23 源审)', () => {
  const sameName = { sessionId: 's-custom', provider: 'user-custom-provider', model: 'deepseek-flash' }
  const targetOwn: { provider: string, model: string, prevModel?: string } = { provider: 'workbench-own', model: 'qa-brain-b', prevModel: 'deepseek-flash' }

  it('★自配 provider 上恰好与 prevModel 同名:needsAlign 与 plan 都不得动它(以前误判受控)', () => {
    expect(needsAlign(sameName, targetOwn)).toBe(false)
    expect(planModelRetargets([sameName], targetOwn, undefined)).toEqual([])
  })

  it('官方 provider 上同名:两边照旧判「要动」(边界没误伤官方那一档)', () => {
    const official = { sessionId: 's-official', provider: 'deepseek-official', model: 'deepseek-flash' }
    expect(needsAlign(official, targetOwn)).toBe(true)
    expect(planModelRetargets([official], targetOwn, undefined))
      .toEqual([{ sessionId: 's-official', provider: 'workbench-own', model: 'qa-brain-b' }])
  })

  it('自配 provider 上同名、且它就在目标 provider 上:更不该动', () => {
    // 自配 provider 恰好也叫 workbench-own(用户自己起了个撞名的路由):受控与目标判断都要基于 provider 身份,不是名字。
    const impersonator = { sessionId: 's-imp', provider: 'user-custom-provider', model: 'deepseek-flash' }
    expect(isSettingControlledSession(impersonator, 'deepseek-flash')).toBe(false)
    expect(needsAlign(impersonator, targetOwn)).toBe(false)
  })
})

it('受控会话重指失败向设置传播，不能伪报成功', async () => {
  await expect(retargetManagedSessions({
    selections: async () => [{ sessionId: 'old', provider: 'workbench-own', model: 'qa-brain-a' }],
    opener: { retarget: async () => false }, change: { provider: 'workbench-own', model: 'qa-brain-b' },
  })).rejects.toThrow()
})
it('续聊对齐不可用时拒绝，不能吞掉 UNKNOWN_MODEL', async () => {
  const opener = createButlerSessionOpener({ on: () => undefined,
    inject: (services: readonly string[], cb: (ctx: never) => void) => {
      if (services[0] === 'sessionController') cb({ sessionController: {
        create: async () => ({ sessionId: 'x' }), prompt: async () => undefined,
        selectModel: async () => { throw new Error('UNKNOWN_MODEL') },
      } } as never)
    },
  } as never, () => undefined, { target: async () => ({ provider: 'workbench-own', model: 'qa-brain-b' }),
    selectionOf: () => ({ provider: 'workbench-own', model: 'qa-brain-a' }), catalogDefault: async () => undefined })
  await expect(opener?.alignModel?.('old')).rejects.toThrow()
})
