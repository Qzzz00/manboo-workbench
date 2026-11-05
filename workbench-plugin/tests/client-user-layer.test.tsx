/**
 * 用户层的加载口 · 客户端那一半(2026-10-21,卡「分层第一刀」)。
 *
 * 钉四件事:
 *   ① 求值:入口代码按 CommonJS 跑,`require` 只认三样(react / react/jsx-runtime / @workbench/host);
 *   ② 清单同步:/state.user_layer 来了就按指纹去取代码,取到之前那一格是「等一下」,不先闪本体那一版;
 *   ③ 坏了跳过:求值出错、导出名不对、画的时候抛错,那一格退回本体自带的(或说一句人话),别的格子照常;
 *   ④ 模板:widget.json 写了 templates 的,只在那几个模板下替。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserLayerStateView, UserLayerWidgetView } from '../src/protocol.ts'
import { USER_LAYER_LOAD_TIMEOUT_MS, UserLayerCell, createUserLayerRegistry, evaluateWidget } from '../src/client/userLayer.tsx'
import { USER_LAYER_HOST_ID, userLayerHost } from '../src/client/userLayerHost.ts'

afterEach(cleanup)

const W: UserLayerWidgetView = { id: 'files', name: '素材管理', status: 'ok', replaces: 'files', export: 'FilesModule', rev: 'aaaaaaaaaaaa' }
const CODE = `
const { jsx } = require('react/jsx-runtime')
function FilesModule(props) { return jsx('p', { children: '她的素材管理:' + props.title }) }
module.exports = { FilesModule }
`

describe('求值', () => {
  it('★CommonJS 跑起来,三样 require 都给', () => {
    const got = evaluateWidget(`
      const React = require('react'); const rt = require('react/jsx-runtime'); const host = require('${USER_LAYER_HOST_ID}')
      module.exports = { ok: typeof React.useState === 'function' && typeof rt.jsx === 'function' && host.contract === 1 }
    `, 'x/index.js')
    expect(got).toEqual({ ok: true, exports: { ok: true } })
  })

  it('接口表里有她那六格用到的每一样', () => {
    expect(typeof userLayerHost.ui.ModuleBox).toBe('function')
    expect(typeof userLayerHost.builtin.FilesModule).toBe('function')
    expect(typeof userLayerHost.builtin.TodoModule).toBe('function')
    expect(typeof userLayerHost.net.postSilently).toBe('function')
    expect(typeof userLayerHost.usage.sourcesOf).toBe('function')
    expect(Object.isFrozen(userLayerHost)).toBe(true)
  })

  it('require 别的东西:不跑,说出只有哪三样', () => {
    const got = evaluateWidget(`require('node:fs')`, 'x/index.js')
    expect(got.ok).toBe(false)
    if (!got.ok) {
      expect(got.problem).toContain('node:fs')
      expect(got.problem).toContain(USER_LAYER_HOST_ID)
    }
  })

  it('写错了(语法错):不跑,说是哪个文件', () => {
    const got = evaluateWidget('function (', 'files/index.js')
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.problem).toContain('files/index.js')
  })
})

function view(...widgets: UserLayerWidgetView[]): UserLayerStateView {
  return { contract: 1, widgets }
}

function Cell({ registry, template }: { registry: ReturnType<typeof createUserLayerRegistry>, template?: string }) {
  return createElement(UserLayerCell, {
    registry,
    slot: 'files',
    templateId: template,
    props: { title: '素材' },
    fallback: (problem?: string) => createElement('p', null, `本体那一版${problem === undefined ? '' : `(${problem})`}`),
    pending: createElement('p', null, '等一下'),
  })
}

describe('清单同步与那一格', () => {
  it('★清单来了:先「等一下」,取到代码就换成她那一版,不先闪本体的', async () => {
    const registry = createUserLayerRegistry()
    let release: (code: string) => void = () => {}
    const asked: string[] = []
    registry.sync(view(W), (widget) => { asked.push(`${widget.id}@${widget.rev}`); return new Promise((resolve) => { release = resolve }) })
    render(<Cell registry={registry} />)
    expect(screen.getByText('等一下')).toBeTruthy()
    expect(screen.queryByText(/本体那一版/)).toBeNull()
    await act(async () => { release(CODE) })
    expect(screen.getByText('她的素材管理:素材')).toBeTruthy()
    expect(asked).toEqual(['files@aaaaaaaaaaaa'])
  })

  it('同一个指纹不重取;指纹变了重取并换上', async () => {
    const registry = createUserLayerRegistry()
    const asked: string[] = []
    const load = async (widget: UserLayerWidgetView) => { asked.push(widget.rev ?? ''); return widget.rev === 'bbbbbbbbbbbb' ? CODE.replace('她的素材管理', '改过的') : CODE }
    await act(async () => { registry.sync(view(W), load) })
    await act(async () => { registry.sync(view(W), load) })
    render(<Cell registry={registry} />)
    expect(screen.getByText('她的素材管理:素材')).toBeTruthy()
    await act(async () => { registry.sync(view({ ...W, rev: 'bbbbbbbbbbbb' }), load) })
    expect(screen.getByText('改过的:素材')).toBeTruthy()
    expect(asked).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
  })

  it('★带 style.css 的小组件:样式注在组件自带 <style> 之前', async () => {
    const registry = createUserLayerRegistry()
    const customStyle = '.custom-compat-style { color: red; }'
    const widgetWithStyle: UserLayerWidgetView = {
      ...W,
      style_rev: 'cssrev123456',
    }
    await act(async () => {
      registry.sync(view(widgetWithStyle), async () => ({
        code: CODE,
        style: customStyle,
      }))
    })
    const { container } = render(<Cell registry={registry} />)
    expect(screen.getByText('她的素材管理:素材')).toBeTruthy()
    const styleEl = container.querySelector('style')
    expect(styleEl).toBeTruthy()
    expect(styleEl?.textContent).toContain('.custom-compat-style')
  })

  it('★style.css 编辑: style_rev 变但 JS rev 不变时重新拉取并替换样式, key 跟着变', async () => {
    const registry = createUserLayerRegistry()
    const widgetV1: UserLayerWidgetView = { ...W, rev: 'rev111111111', style_rev: 'srev11111111' }
    const widgetV2: UserLayerWidgetView = { ...W, rev: 'rev111111111', style_rev: 'srev22222222' }

    await act(async () => {
      registry.sync(view(widgetV1), async () => ({ code: CODE, style: '.v1 { color: red }' }))
    })
    const hit1 = registry.resolve('files', 'ops')
    expect(hit1.kind).toBe('ready')
    if (hit1.kind !== 'ready') throw new Error('unexpected')
    expect(hit1.style).toBe('.v1 { color: red }')
    expect(hit1.key).toContain('srev11111111')

    // 下一拍: 仅 style_rev 变了, JS rev 没变
    await act(async () => {
      registry.sync(view(widgetV2), async () => ({ code: CODE, style: '.v2 { color: blue }' }))
    })
    const hit2 = registry.resolve('files', 'ops')
    expect(hit2.kind).toBe('ready')
    if (hit2.kind !== 'ready') throw new Error('unexpected')
    expect(hit2.style).toBe('.v2 { color: blue }')
    expect(hit2.key).toContain('srev22222222')
  })

  it('★style.css 删除: style_rev 变为 undefined 时重新同步并移除样式', async () => {
    const registry = createUserLayerRegistry()
    const widgetWithStyle: UserLayerWidgetView = { ...W, rev: 'rev111111111', style_rev: 'srev11111111' }
    const widgetWithoutStyle: UserLayerWidgetView = { ...W, rev: 'rev111111111' }

    await act(async () => {
      registry.sync(view(widgetWithStyle), async () => ({ code: CODE, style: '.v1 { color: red }' }))
    })
    const hit1 = registry.resolve('files', 'ops')
    expect(hit1.kind).toBe('ready')
    if (hit1.kind !== 'ready') throw new Error('unexpected')
    expect(hit1.style).toBe('.v1 { color: red }')

    // 下一拍: style.css 被删除, style_rev 变为 undefined
    await act(async () => {
      registry.sync(view(widgetWithoutStyle), async () => ({ code: CODE, style: undefined }))
    })
    const hit2 = registry.resolve('files', 'ops')
    expect(hit2.kind).toBe('ready')
    if (hit2.kind !== 'ready') throw new Error('unexpected')
    expect(hit2.style).toBeUndefined()
  })

  it('★旧异步加载后到不能覆盖新样式: 旧 style 请求完成慢于新版本时不覆盖', async () => {
    const registry = createUserLayerRegistry()
    const widgetV1: UserLayerWidgetView = { ...W, rev: 'rev111111111', style_rev: 'srev11111111' }
    const widgetV2: UserLayerWidgetView = { ...W, rev: 'rev111111111', style_rev: 'srev22222222' }

    let resolveV1: (value: { code: string, style: string }) => void = () => {}
    let resolveV2: (value: { code: string, style: string }) => void = () => {}

    // V1 开始加载
    registry.sync(view(widgetV1), () => new Promise(res => { resolveV1 = res }))

    // 很快用户又改了一次样式, V2 开始加载
    registry.sync(view(widgetV2), () => new Promise(res => { resolveV2 = res }))

    // V2 先加载完成
    await act(async () => {
      resolveV2({ code: CODE, style: '.v2-latest { color: green }' })
    })
    const hitAfterV2 = registry.resolve('files', 'ops')
    expect(hitAfterV2.kind).toBe('ready')
    if (hitAfterV2.kind !== 'ready') throw new Error('unexpected')
    expect(hitAfterV2.style).toBe('.v2-latest { color: green }')

    // 迟到的 V1 完成
    await act(async () => {
      resolveV1({ code: CODE, style: '.v1-stale { color: red }' })
    })

    // 依然保留最新的 V2, 迟到的 V1 被丢弃
    const hitFinal = registry.resolve('files', 'ops')
    expect(hitFinal.kind).toBe('ready')
    if (hitFinal.kind !== 'ready') throw new Error('unexpected')
    expect(hitFinal.style).toBe('.v2-latest { color: green }')
  })

  it('/state 里没有 user_layer(老服务、展示台):已装的原样留着', async () => {
    const registry = createUserLayerRegistry()
    registry.install(W, CODE)
    registry.sync(undefined, async () => '')
    render(<Cell registry={registry} />)
    expect(screen.getByText('她的素材管理:素材')).toBeTruthy()
  })

  it('清单里拿掉了:那一格回本体那一版', async () => {
    const registry = createUserLayerRegistry()
    registry.install(W, CODE)
    render(<Cell registry={registry} />)
    await act(async () => { registry.sync(view(), async () => '') })
    expect(screen.getByText('本体那一版')).toBeTruthy()
  })

  it('★清单说坏了:本体那一版 + 那句人话', async () => {
    const registry = createUserLayerRegistry()
    registry.sync(view({ id: 'files', name: '素材管理', status: 'broken', problem: 'widget.json 读不出来' }), async () => '')
    render(<Cell registry={registry} />)
    expect(screen.getByText('本体那一版(widget.json 读不出来)')).toBeTruthy()
  })

  it('取不到代码:先「工作台这会儿忙」退避重试,不算坏;重试用尽才回本体那一版并记下来', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      await act(async () => { registry.sync(view(W), async () => { throw new Error('404') }) })
      render(<Cell registry={registry} />)
      // 第一次没取到:不是 failed,也不记问题 —— 这一格还没坏,是工作台那会儿忙。
      await act(async () => { await vi.advanceTimersByTimeAsync(USER_LAYER_LOAD_TIMEOUT_MS) })
      expect(screen.getByText('等一下')).toBeTruthy()
      expect(registry.problems().size).toBe(0)
      // 退避全部跑完:这时才算「没装上」,问题记下来。
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(screen.getByText(/本体那一版/)).toBeTruthy()
      expect(registry.problems().get('files')).toMatch(/读不到/)
    }
    finally { vi.useRealTimers() }
  })

  it('导出名不对:回本体那一版,问题记下来', async () => {
    const registry = createUserLayerRegistry()
    expect(registry.install({ ...W, export: 'Nope' }, CODE)).toBe(false)
    render(<Cell registry={registry} />)
    expect(screen.getByText(/本体那一版/)).toBeTruthy()
    expect(registry.problems().get('files')).toContain('Nope')
  })

  it('★画的时候抛错:这一格回本体那一版,不白屏,问题记下来', async () => {
    const registry = createUserLayerRegistry()
    registry.install(W, `module.exports = { FilesModule() { throw new Error('数据不对') } }`)
    const quiet = console.error
    console.error = () => {}
    try {
      render(<div><Cell registry={registry} /><p>旁边那一格</p></div>)
    }
    finally { console.error = quiet }
    expect(screen.getByText(/本体那一版/)).toBeTruthy()
    expect(screen.getByText('旁边那一格')).toBeTruthy()
    expect(registry.problems().get('files')).toContain('数据不对')
  })

  it('只在 ops 模板下替的:别的模板(含模板缺席)用本体那一版', () => {
    const registry = createUserLayerRegistry()
    registry.install({ ...W, templates: ['ops'] }, CODE)
    const { unmount } = render(<Cell registry={registry} template="ops" />)
    expect(screen.getByText('她的素材管理:素材')).toBeTruthy()
    unmount()
    render(<Cell registry={registry} />)
    expect(screen.getByText('本体那一版')).toBeTruthy()
  })
})

describe('装得怎样报给服务端(自愈:画好过的存成上一版,坏了的端上一版)', () => {
  it('★画出来了:报 ok 一次', async () => {
    const registry = createUserLayerRegistry()
    const said: unknown[] = []
    registry.setReporter(outcome => said.push(outcome))
    registry.install(W, CODE)
    const { rerender } = render(<Cell registry={registry} />)
    rerender(<Cell registry={registry} />)
    expect(said).toEqual([{ id: 'files', rev: 'aaaaaaaaaaaa', ok: true }])
  })

  it('画的时候抛错:报坏,不报 ok', () => {
    const registry = createUserLayerRegistry()
    const said: { ok: boolean, problem?: string }[] = []
    registry.setReporter(outcome => said.push(outcome))
    registry.install(W, `module.exports = { FilesModule() { throw new Error('数据不对') } }`)
    const quiet = console.error
    console.error = () => {}
    try { render(<Cell registry={registry} />) }
    finally { console.error = quiet }
    expect(said.map(one => one.ok)).toEqual([false])
    expect(said[0]!.problem).toContain('数据不对')
  })

  it('代码跑不起来:报坏', () => {
    const registry = createUserLayerRegistry()
    const said: { ok: boolean }[] = []
    registry.setReporter(outcome => said.push(outcome))
    registry.install(W, 'function (')
    expect(said.map(one => one.ok)).toEqual([false])
  })
})
