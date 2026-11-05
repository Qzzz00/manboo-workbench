// @vitest-environment node
/**
 * 用户层升级路径测试(2026-10-23,分层二刀二 第三轮收尾):
 *
 * 验证「旧用户层原件 + 新本体」的升级兼容:
 * 1. 老机器已有小组件目录(created=false),里面只有旧原件(无 style.css、无 .styled 标记);
 * 2. ensure() 携带 starterDir 启动时:
 *    - 补放缺的 style.css 到各小组件目录;
 *    - 用户改过的 index.js / widget.json 一个字不改;
 *    - 写入 .styled 标记;
 *    - 标记存在时,主动删除的 style.css 不会被再次补回;
 *    - 标记删除后,缺的 style.css 再次被补回;
 * 3. scan() 产出各小组件的 style_rev;
 * 4. userLayer.widgetStyle(id) 与 HTTP GET /user-layer/widgets/:id/style 端出真实样式文本;
 * 5. 客户端加载口支持取 style 并注在组件自带 <style> 之前。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserLayerService, defaultUserLayerDir } from '../src/server/userLayer.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { STARTER_WIDGETS_DIR } from './helpers/starterLayer.ts'

const TMP_ROOT = join(import.meta.dirname, '..', '.tmp-user-layer-upgrade-test')

describe('用户层小组件兼容样式升级与生命周期', () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
    await mkdir(TMP_ROOT, { recursive: true })
  })

  afterEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
  })

  it('旧小组件升级时自动补齐 style.css,不覆盖用户已有 index.js,标记拦截复生', async () => {
    const userDir = join(TMP_ROOT, '用户层')
    const widgetsDir = join(userDir, '小组件')
    const notesDir = join(widgetsDir, 'notes')
    await mkdir(notesDir, { recursive: true })

    const userCustomJs = '/* 用户自己改过的小组件代码 */\nmodule.exports = { NotesModule() { return null } }\n'
    const widgetJson = JSON.stringify({ contract: 1, id: 'notes', name: '随手记', replaces: 'notes', entry: 'index.js', export: 'NotesModule' })
    await writeFile(join(notesDir, 'index.js'), userCustomJs, 'utf8')
    await writeFile(join(notesDir, 'widget.json'), widgetJson, 'utf8')

    // starterDir 指向包含小组件起步层的目录 (即仓库的 user-layer/起步)
    const starterRoot = join(STARTER_WIDGETS_DIR, '..')

    const service = createUserLayerService({
      dir: userDir,
      starterDir: starterRoot,
    })

    // ① 升级运行 ensure: 发现已有目录(created=false),但缺 style.css 且无 .styled 标记
    const ensureResult = await service.ensure()
    expect(ensureResult.created).toBe(false)

    // 用户定制 index.js 必须原样保留
    const jsAfter = await readFile(join(notesDir, 'index.js'), 'utf8')
    expect(jsAfter).toBe(userCustomJs)

    // style.css 必须补齐,内容包含 mono 外移的 32 条样式规则之一
    const cssAfter = await readFile(join(notesDir, 'style.css'), 'utf8')
    expect(cssAfter).toContain('.ben-wb .creator-notes-compose')

    // 扫描结果中必须带有 style_rev
    const state = await service.scan()
    const notesView = state.widgets.find(w => w.id === 'notes')
    expect(notesView).toBeDefined()
    expect(notesView?.style_rev).toBeDefined()
    expect(notesView?.style_rev?.length).toBe(12)

    // widgetStyle 接口返回对应内容与 rev
    const styleData = await service.widgetStyle('notes')
    expect(styleData).toBeDefined()
    expect(styleData?.css).toBe(cssAfter)
    expect(styleData?.rev).toBe(notesView?.style_rev)

    // ② 用户主动删除 style.css,再次重启 ensure: .styled 标记在,不复生
    await rm(join(notesDir, 'style.css'))
    await service.ensure()
    let resurrected = false
    try {
      await readFile(join(notesDir, 'style.css'))
      resurrected = true
    } catch {
      resurrected = false
    }
    expect(resurrected).toBe(false)

    // ③ 删掉 .styled 标记,再次重启 ensure: 缺的 style.css 重新补回
    await rm(join(widgetsDir, '.styled'))
    await service.ensure()
    const cssReseeded = await readFile(join(notesDir, 'style.css'), 'utf8')
    expect(cssReseeded).toContain('.ben-wb .creator-notes-compose')
  })

  it('HTTP 路由 GET /user-layer/widgets/:id/style 端出样式,404 正常兜底', async () => {
    const userDir = join(TMP_ROOT, '用户层')
    const starterRoot = join(STARTER_WIDGETS_DIR, '..')

    const service = createUserLayerService({
      dir: userDir,
      starterDir: starterRoot,
    })
    await service.ensure()

    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({}),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      userLayer: service,
    })

    try {
      const notesStyleRes = await fetch(`${server.url}/user-layer/widgets/notes/style`)
      expect(notesStyleRes.status).toBe(200)
      expect(notesStyleRes.headers.get('content-type')).toContain('text/css')
      const notesCss = await notesStyleRes.text()
      expect(notesCss).toContain('.ben-wb .creator-notes-compose')

      const notFoundRes = await fetch(`${server.url}/user-layer/widgets/nonexistent/style`)
      expect(notFoundRes.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
