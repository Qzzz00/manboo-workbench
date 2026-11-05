/**
 * 初始化页的纯逻辑(2026-09-17 卡 A):九步怎么分、灯是什么色、从哪儿进来。
 *
 * 灯的规则单独测,是因为它是这一页里**最容易悄悄说错**的东西 —— 一盏错的绿灯会让 Ben
 * 以为装好了,而这一页的全部价值就是"如实告诉他还差什么"。
 */
import { describe, expect, it } from 'vitest'
import { groupSetupSteps, lampOf, setupHeadline, setupRequestedIn, SETUP_STEPS } from '../src/client/setup/steps.ts'
import type { SetupItem, SetupStatus } from '../src/server/setup/types.ts'

function item(over: Partial<SetupItem> = {}): SetupItem {
  return { key: 'k', label: 'L', state: 'ok', detail: 'd', step: 1, ...over }
}

function status(items: readonly SetupItem[]): SetupStatus {
  return {
    items,
    all_ok: items.every(one => one.optional === true || one.state === 'ok'),
    optional_pending: items.filter(one => one.optional === true && one.state !== 'ok').length,
    checked_at: '2026-09-17T10:00:00.000Z',
  }
}

describe('九步分组', () => {
  it('就是设计文档里那九步,顺序不变', () => {
    expect(SETUP_STEPS.map(step => step.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(SETUP_STEPS.map(step => step.title)).toEqual([
      '就绪检查', '仓库在哪', '系统授权', '密钥与钩子', '客户端体检', '目录与例程', '事务官', '手机', '收尾',
    ])
  })

  it('体检项按 step 落到对应那一步', () => {
    const steps = groupSetupSteps(status([item({ key: 'node', step: 1 }), item({ key: 'documents', step: 3 })]))
    expect(steps[0]?.items.map(one => one.key)).toEqual(['node'])
    expect(steps[2]?.items.map(one => one.key)).toEqual(['documents'])
  })

  it('体检还没回来时,有体检项的前五步是「程序在做」,不是「已就绪」', () => {
    const steps = groupSetupSteps(undefined)
    expect(steps.slice(0, 5).map(step => step.lamp)).toEqual(['busy', 'busy', 'busy', 'busy', 'busy'])
  })

  it('有安装作业在跑,那一步就是「程序在做」', () => {
    const steps = groupSetupSteps(status([item({ step: 1 })]), ['runtime'])
    expect(steps[0]?.lamp).toBe('busy')
  })

  it('web_login 那条作业点亮的是第 3 步', () => {
    const steps = groupSetupSteps(status([item({ step: 1 }), item({ key: 'w', step: 3 })]), ['web_login'])
    expect(steps[0]?.lamp).toBe('ok')
    expect(steps[2]?.lamp).toBe('busy')
  })

  it('没有体检项的后四步一律「等你填」——那几步本来就只有你能做', () => {
    const steps = groupSetupSteps(status([]))
    expect(steps.slice(5).map(step => step.lamp)).toEqual(['fill', 'fill', 'fill', 'fill'])
  })

  it('可选项没就绪不点灯,但会单独数出来', () => {
    const steps = groupSetupSteps(status([
      item({ key: 'a', step: 5, state: 'needs_user', optional: true }),
      item({ key: 'b', step: 5, state: 'needs_user', optional: true }),
    ]))
    expect(steps[4]?.lamp).toBe('ok')
    expect(steps[4]?.optionalPending).toBe(2)
  })
})

describe('一步一盏灯', () => {
  it('全 ok 就是绿', () => {
    expect(lampOf([item(), item()], false)).toBe('ok')
  })

  it('有能一键装的 → 等你点一下', () => {
    expect(lampOf([item({ state: 'missing' })], false)).toBe('click')
    expect(lampOf([item({ state: 'stale' })], false)).toBe('click')
  })

  it('只剩「只有你能做的」→ 等你填', () => {
    expect(lampOf([item({ state: 'needs_user' })], false)).toBe('fill')
  })

  it('两种都有时先说「等你点一下」——先让程序把能做的做完,免得白跑一趟系统设置', () => {
    expect(lampOf([item({ state: 'needs_user' }), item({ state: 'missing' })], false)).toBe('click')
  })

  it('在跑的时候盖过一切', () => {
    expect(lampOf([item({ state: 'needs_user' })], true)).toBe('busy')
  })
})

describe('页头那句话', () => {
  it('还没查出来就说在查', () => {
    expect(setupHeadline(undefined)).toBe('正在体检…')
  })

  it('全绿就说全绿', () => {
    expect(setupHeadline(status([item()]))).toBe('全都就绪了。')
  })

  it('还差几项就说几项,不四舍五入', () => {
    expect(setupHeadline(status([item({ state: 'missing' }), item({ key: 'b', state: 'needs_user' }), item({ key: 'c' })])))
      .toBe('还差 2 项。')
  })

  it('可选项单独说,不混进"还差"里', () => {
    const text = setupHeadline(status([item(), item({ key: 'b', state: 'needs_user', optional: true })]))
    expect(text).toContain('要紧的都就绪了')
    expect(text).toContain('1 项可选')
  })
})

describe('从哪儿进来', () => {
  it('?setup=1 与 #setup 都认', () => {
    expect(setupRequestedIn('?setup=1', '')).toBe(true)
    expect(setupRequestedIn('', '#setup')).toBe(true)
    expect(setupRequestedIn('?ben-workbench=app', '')).toBe(false)
    expect(setupRequestedIn('', '')).toBe(false)
  })

  it('地址栏里是什么怪东西都不该让它抛', () => {
    expect(setupRequestedIn('?%', '#')).toBe(false)
  })
})
