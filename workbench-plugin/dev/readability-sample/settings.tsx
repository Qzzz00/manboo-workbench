/**
 * 设置六组样张(2026-10-22,新 UI 第二轮 · 设置六组)。挂真的 `SettingsDialog`,各接口由 `tests/settingsFixture.ts`
 * 那一份假回包答(与用例同一份,文字尽量取评审页同一处的示例),截图时与评审页 `slot=settings` 并排对照。
 *
 *   ?theme=light|dark   暗亮(缺省暗)
 *   ?group=butler|devices|agents|machine|update|advanced   开在哪一组
 *   ?w=1508&h=925       设置那一块的宽高(缺省按评审页 2560×1440 横屏时窗口槽的大小)
 *   ?scene=empty        规矩、学到的做法都没有记录(对照评审页「空态」)
 *   ?click=撤回&click=…  载入后按顺序点那几颗键(按钮上的字或 aria-label),截确认弹层、摊开的编辑区用
 */
import { createRoot } from 'react-dom/client'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/base.css'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css'
import { STYLE } from '../../src/client/style.ts'
import { SettingsDialog } from '../../src/client/SettingsDialog.tsx'
import { SETTINGS_PROPS, settingsFetch } from '../../tests/settingsFixture.ts'

const query = new URLSearchParams(location.search)
const theme = query.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme
if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
const width = Number(query.get('w') ?? 1508)
const height = Number(query.get('h') ?? 925)
const empty = query.get('scene') === 'empty'
const { fetchImpl } = settingsFetch(empty ? { '/butler/rules': { rules: [], retired: [] }, '/habits': { trial: [], kept: [], retired: [] } } : {})

const page = document.createElement('style')
page.textContent = `
html,body{margin:0;background:var(--wb-back)}
.ben-wb.ss-root{position:relative;inset:auto;width:${width}px;height:${height}px;overflow:hidden;background:var(--wb-back)}
.ben-wb.ss-root .ben-wb__setdlg-backdrop{position:absolute;inset:0;padding:0;background:transparent}
.ben-wb.ss-root .ben-wb__setdlg{position:relative;inset:auto;width:${width}px;height:${height}px;max-width:none;max-height:none}
`
const base = document.createElement('style')
base.textContent = STYLE
document.head.append(base, page)
createRoot(document.getElementById('root')!).render(
  <main className="ben-wb ss-root">
    <SettingsDialog
      baseUrl="http://sample.invalid"
      fetchImpl={fetchImpl}
      onClose={() => {}}
      {...SETTINGS_PROPS}
      onOpenSetup={() => {}}
      onReplayFirstRun={() => {}}
      onRedoOnboarding={() => {}}
      {...(query.get('group') === null ? {} : { openAt: { group: query.get('group')! } })}
    />
  </main>,
)
// ?click=…:载入后按顺序点那几颗键(各节自己拉数据,先等一会儿)。
query.getAll('click').forEach((label, at) => {
  setTimeout(() => {
    const hit = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(one => one.textContent?.trim() === label || one.getAttribute('aria-label') === label)
    hit?.scrollIntoView({ block: 'center' })
    hit?.click()
  }, 1200 + at * 400)
})
