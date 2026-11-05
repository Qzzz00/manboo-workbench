/**
 * 素材管理的**第八格「收藏网址」**(2026-09-21,白板第一节 Ben 草图上素材管理的第一项)。
 *
 * 这一份钉三件事:
 * 1. 做产品模板(不给 assetFiles)时**这一颗不画** —— 那边没有"素材"这回事;
 * 2. 它排在七个文件夹后面,而且看得出是个**文件**(data-kind="file"),点法与文件夹一样
 *    走 `/files/reveal`(在 Finder 里选中它,不新开一条"替你打开文件"的执行口子);
 * 3. 服务端那一份路径是真从模板算出来的(`templateStateView` 回的 `asset_files`)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FilesModule } from '../src/client/FilesModule.tsx'
import { templateStateView } from '../src/server/templateStore.ts'
import { OPS_ASSET_DIRS, OPS_FAVORITES_NAME, PRODUCT_TEMPLATE } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const OPS_TEMPLATE = await loadStarterLayoutTemplate()

afterEach(cleanup)

const BOX = {
  id: 'files',
  title: '素材管理',
  basisPct: 30,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

function mount(
  props: { assetDirs?: Record<string, string>, assetFiles?: Record<string, string> },
  calls: { url: string, body: unknown }[] = [],
) {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
  }) as unknown as typeof fetch
  render(
    // projects 一个都不带 path:这一格只测素材那一排按钮,图谱体那边说「还没有带本机路径的项目」,
    // 不发请求不抢戏。旧 props(view/pin/helper/…)2026-10-23 起收而不用,这里一个都不传。
    <FilesModule
      box={BOX}
      header={<h2 id="h">素材管理</h2>}
      headingId="h"
      baseUrl="http://127.0.0.1:1"
      fetchImpl={fetchImpl}
      projects={[]}
      {...props}
    />,
  )
  return calls
}

describe('第八格「收藏网址」', () => {
  it('不给 assetFiles(做产品模板)→ 这一颗不画', () => {
    mount({})
    expect(document.querySelector('.ben-wb__assets')).toBeNull()
  })

  it('运营模板:七个文件夹在前,收藏网址在最后,而且标着自己是个文件', () => {
    mount({
      assetDirs: Object.fromEntries(OPS_ASSET_DIRS.map(name => [name, `/Users/example/运营/素材/${name}`])),
      assetFiles: { [OPS_FAVORITES_NAME]: '/Users/example/运营/素材/收藏网址.md' },
    })
    const names = [...document.querySelectorAll('.ben-wb__assets button')].map(node => node.textContent)
    expect(names).toEqual([...OPS_ASSET_DIRS, OPS_FAVORITES_NAME])
    expect(screen.getByRole('button', { name: OPS_FAVORITES_NAME })).toHaveAttribute('data-kind', 'file')
  })

  it('点它 → 在 Finder 里定位到那个文件(走既有的 /files/reveal,没有新口子)', async () => {
    const calls = mount({ assetFiles: { [OPS_FAVORITES_NAME]: '/Users/example/运营/素材/收藏网址.md' } })
    act(() => { screen.getByRole('button', { name: OPS_FAVORITES_NAME }).click() })
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/files/reveal'))).toBe(true))
    expect(calls.find(call => call.url.endsWith('/files/reveal'))?.body)
      .toEqual({ path: '/Users/example/运营/素材/收藏网址.md' })
    // 没有第二条路径被调用过 —— 特别是没有"替你打开这个文件"那种。
    expect(calls).toHaveLength(1)
  })

  it('鼠标停上去那一句把格式说清楚(他要能自己手写一行)', () => {
    mount({ assetFiles: { [OPS_FAVORITES_NAME]: '/Users/example/运营/素材/收藏网址.md' } })
    expect(screen.getByRole('button', { name: OPS_FAVORITES_NAME }).getAttribute('title'))
      .toContain('一行一条:标题 + 链接 + 备注')
  })
})

describe('服务端那一份 asset_files', () => {
  it('运营模板 + 配了工作目录 → 一条,指向 素材/收藏网址.md', () => {
    const view = templateStateView(OPS_TEMPLATE, { butlerCwd: '/Users/example/运营', hasBackup: false })
    expect(view.asset_files).toEqual({ [OPS_FAVORITES_NAME]: '/Users/example/运营/素材/收藏网址.md' })
    // 七个文件夹那一份不受影响(账号也在 folders 里,所以这里只看素材那七个都在)
    for (const dir of OPS_ASSET_DIRS) expect(view.asset_dirs?.[dir]).toBe(`/Users/example/运营/素材/${dir}`)
  })

  it('做产品模板 → 整块缺席', () => {
    const view = templateStateView(PRODUCT_TEMPLATE, { butlerCwd: '/Users/example/Code', hasBackup: false })
    expect(view.asset_files).toBeUndefined()
  })

  it('工作目录没配 → 整块缺席(**不猜一个路径**)', () => {
    const view = templateStateView(OPS_TEMPLATE, { butlerCwd: undefined, hasBackup: false })
    expect(view.asset_files).toBeUndefined()
  })
})
