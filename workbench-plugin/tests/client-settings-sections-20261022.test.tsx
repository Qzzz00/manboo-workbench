/**
 * 设置六组每一节的内部照 Codex 全局评审页重排(2026-10-22,新 UI 第二轮 · 设置六组)。
 *
 * 依据:`docs/设计-全局UI视觉-A-2026-10-21.html` 的 `slot=settings`(各组 `group=butler…advanced`),
 * 源在 `docs/assets/global-ui-review-2026-10-21/live/app.js` 的 `butlerSettings()` … `advancedSettings()`。
 * 每条断言写着出自稿里哪一件;稿里没画、我们已上线的功能(试用 / 撤回、提示词覆盖、令牌、实验开关……)
 * 收进折叠或次级入口,这里同样钉住「还在、点得到」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_ENTRIES, SETTINGS_GROUPS, SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'
import { SETTINGS_PROPS, settingsFetch } from './settingsFixture.ts'
import { CONFIRMS } from '../src/client/ui/index.tsx'
import { DEFAULT_WORK_TYPES } from '../src/protocol.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(cleanup)

let scrolled: string[] = []
beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id || (this.getAttribute('aria-labelledby') ?? '')) } as typeof Element.prototype.scrollIntoView
})

function renderAll(over: Record<string, unknown> = {}) {
  const server = settingsFetch(over)
  render(
    <SettingsDialog
      baseUrl="http://x"
      fetchImpl={server.fetchImpl}
      onClose={() => {}}
      {...SETTINGS_PROPS}
      onOpenSetup={() => {}}
      onReplayFirstRun={() => {}}
      onRedoOnboarding={() => {}}
    />,
  )
  return server
}

/** 节:按节名找 `<section>`(稿 `.setting-section` 的 h3)。 */
const section = async (title: string): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name: title, level: 3 })
  return heading.closest('section') as HTMLElement
}

describe('组首(.setting-heading + .settings-jump)', () => {
  it('每组:组名(h2)+ 稿上那一句说明;跳转小钮列的就是下面各节的节名(稿里没画的节在最后)', async () => {
    renderAll()
    const leads: Record<string, string> = {
      butler: '规矩、学到的做法,以及你想交代的事。',
      devices: '管理设备连接与电脑唤醒。',
      agents: '先看能做什么,再管理账号和额度来源。',
      machine: '账号、布局和你自己的组件。',
      update: '查看当前版本与更新状态。',
      advanced: '目录、连接器和诊断入口。',
    }
    for (const one of SETTINGS_GROUPS) {
      await openGroup(one.label)
      const panel = screen.getByRole('tabpanel')
      expect(within(panel).getByRole('heading', { level: 2, name: one.label })).toBeInTheDocument()
      expect(within(panel).getByText(leads[one.id]!)).toBeInTheDocument()
      // 每颗小钮对着下面一节:节名一致(「交代与偏好」照稿,对「事务官照你的意思办」那一节)。
      // 2026-10-23(分层二刀一)拍板:导航短名「派活与提醒」对节名「派活与办完提醒」,
      // 两处字不一样是**已定设计**(交接 :58/:60/:65),不是回归 —— 这里验的是这条明确映射:
      // 小钮照短名列、节照长名画,一颗小钮对着那一节。
      const SECTION_TITLE: Record<string, string> = { 'dispatch-prefs': '派活与办完提醒' }
      for (const entry of SETTINGS_ENTRIES[one.id].filter(e => e.id !== 'prompts' && e.id !== 'update')) {
        const title = SECTION_TITLE[entry.id] ?? entry.title
        expect(await within(panel).findByRole('heading', { level: 3, name: title }), `「${one.label}」里没有「${title}」那一节`).toBeInTheDocument()
      }
    }
  })

  it('「事务官的规矩」顶上一排跳转小钮,字照稿;点一下跳到那一节', async () => {
    renderAll()
    for (const title of ['记住的规矩', '它学到了什么', '派活与办完提醒', '哨兵']) await section(title)
    const jump = screen.getByRole('navigation', { name: '这一组有什么' })
    // 短名照稿列(「派活与提醒」是导航短名,节名「派活与办完提醒」在映射里另验)。
    expect(within(jump).getAllByRole('button').map(one => one.textContent)).toEqual(['记住的规矩', '它学到了什么', '交代与偏好', '派活与提醒', '哨兵', '形象与音色', '会议转写', '演示数据'])
    expect(SETTINGS_ENTRIES.butler.map(one => one.title)).toEqual(['记住的规矩', '它学到了什么', '交代与偏好', '派活与提醒', '哨兵', '形象与音色', '会议转写', '演示数据'])
    // 短名 → 长节名的锚点:点「派活与提醒」跳到「派活与办完提醒」那一节(section 的 id)。
    fireEvent.click(within(jump).getByRole('button', { name: '派活与提醒' }))
    expect(scrolled.at(-1)).toBe('ben-wb-dispatch-prefs')
    await section('哨兵')
    fireEvent.click(within(jump).getByRole('button', { name: '哨兵' }))
    expect(scrolled.at(-1)).toMatch(/sentinel/)
  })

  it('状态挪到各节标题右边那一句小字(规矩条数、学到的条数)', async () => {
    renderAll()
    expect(within(await section('记住的规矩')).getByText('3 条正在照做 · 1 条已撤下')).toHaveClass('ben-wb__ss-aside')
    expect(within(await section('它学到了什么')).getByText('2 条试用 · 0 条留下')).toHaveClass('ben-wb__ss-aside')
  })
})

describe('事务官的规矩', () => {
  it('记住的规矩:一句 + 出处 · 范围,右边「改」与 ✕;一行添新规矩;「已撤下 N 条 · 展开 ›」', async () => {
    const { posts } = renderAll()
    const box = await section('记住的规矩')
    const row = within(box).getByText('交回工作前,先说明检查结果').closest('.ben-wb__srow') as HTMLElement
    expect(within(row).getByText(/设置里说的 · 10-21 09:12 · 验收/)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '改' })).toBeInTheDocument()
    // 范围下拉只在「改」的时候出来(稿里那一行只有一句 + 出处 · 范围)
    expect(within(box).queryByRole('combobox', { name: '这条管哪一块' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: '撤下规矩' }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/butler/rules/remove', body: { id: 'r1' } }))

    expect(within(box).getByPlaceholderText('添一条长期规矩')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: '记下' })).toBeInTheDocument()

    const fold = within(box).getByText('已撤下 1 条').closest('details') as HTMLElement
    expect(within(fold).getByText('展开 ›')).toBeInTheDocument()
    expect(within(fold).queryByText('例行进展每次都提醒')).toBeNull()
    fireEvent.click(within(fold).getByText('已撤下 1 条'))
    fireEvent.click(within(fold).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/butler/rules/restore', body: { id: 'r4' } }))
  })

  it('改一条:就地变输入框,范围下拉也在这时出来,「存」送出', async () => {
    const { posts } = renderAll()
    const box = await section('记住的规矩')
    const row = within(box).getByText('先给结论,再说原因').closest('.ben-wb__srow') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '改' }))
    const input = within(box).getByRole('textbox', { name: '改这条规矩' })
    fireEvent.change(input, { target: { value: '先给结论' } })
    expect(within(box).getByRole('combobox', { name: '这条管哪一块' })).toHaveValue('say')
    fireEvent.click(within(box).getByRole('button', { name: '存' }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/butler/rules/update', body: { id: 'r2', text: '先给结论' } }))
  })

  it('它学到了什么:每条一句 + 撤回,计数 / 试用 / 验证三格点阵,各自数', async () => {
    const { posts } = renderAll()
    const box = await section('它学到了什么')
    const one = within(box).getByText('界面修改,先交给常用的那一家').closest('.ben-wb__slearn') as HTMLElement
    expect(within(one).getByRole('group', { name: '计数 6' })).toBeInTheDocument()
    expect(within(one).getByRole('group', { name: '试用 3' })).toBeInTheDocument()
    expect(within(one).getByRole('group', { name: '验证 0' })).toBeInTheDocument()
    expect(within(one).getByRole('group', { name: '计数 6' }).querySelectorAll('.ben-wb__sdots i')).toHaveLength(6)
    expect(within(box).getByText('一点一次 · 三类分别计数')).toBeInTheDocument()

    fireEvent.click(within(one).getByRole('button', { name: '撤回' }))
    const ask = screen.getByRole('dialog', { name: CONFIRMS.withdrawHabit.title })
    expect(ask).toHaveTextContent('撤回后不再继续试用,保留原来的依据记录。')
    fireEvent.click(within(ask).getByRole('button', { name: CONFIRMS.withdrawHabit.confirm }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/habits/revoke', body: { id: 'h1' } }))
  })

  it('它学到了什么:依据收在每条下面的折叠里;「依据与判据」摊开口径与进化日志;撤掉的在「已撤下」里能恢复', async () => {
    const { posts } = renderAll()
    const box = await section('它学到了什么')
    const one = within(box).getByText('界面修改,先交给常用的那一家').closest('.ben-wb__slearn') as HTMLElement
    expect(within(one).queryByText('第 1 次派给 Codex')).toBeNull()
    fireEvent.click(within(one).getByText('依据 6 条'))
    expect(within(one).getByText('第 1 次派给 Codex')).toBeInTheDocument()

    fireEvent.click(within(box).getByRole('button', { name: '依据与判据' }))
    expect(within(box).getByText(/三格各自数,不相除/)).toBeInTheDocument()
    fireEvent.click(within(box).getByRole('button', { name: '看进化日志(最近几条)' }))
    expect(await within(box).findByText('10-21 界面修改先交给 Codex')).toBeInTheDocument()

    fireEvent.click(within(box).getByText('已撤下 1 条'))
    fireEvent.click(within(box).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/habits/restore', body: { id: 'h3' } }))
  })

  it('事务官照你的意思办:几项各一行「改」;「各个环节的偏好」一行「查看」;「只读工作手册」是文字入口', async () => {
    const { posts } = renderAll()
    const box = await section('事务官照你的意思办')
    const name = within(box).getByText('它叫什么').closest('.ben-wb__srow') as HTMLElement
    expect(within(name).getByText('事务官')).toBeInTheDocument()
    fireEvent.click(within(name).getByRole('button', { name: '改' }))
    fireEvent.change(within(box).getByRole('textbox', { name: '改「它叫什么」' }), { target: { value: '小事' } })
    fireEvent.click(within(box).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/butler/prompts/save', body: { name: '它叫什么', body: '小事' } }))

    const stages = within(box).getByText('各个环节的偏好').closest('.ben-wb__srow') as HTMLElement
    expect(within(stages).getByText('选题、派活、交回检查')).toBeInTheDocument()
    expect(within(box).queryByText('先看上周数据')).toBeNull()
    fireEvent.click(within(stages).getByRole('button', { name: '查看' }))
    expect(within(box).getByText('先看上周数据')).toBeInTheDocument()

    expect(within(box).queryByText('运营-发布包装')).toBeNull()
    fireEvent.click(within(box).getByRole('button', { name: '只读工作手册' }))
    expect(within(box).getByText('运营-发布包装')).toBeInTheDocument()
  })

  it('改过的那一项:恢复默认、撤到上一版收在「改」里面', async () => {
    const { posts } = renderAll()
    const box = await section('事务官照你的意思办')
    const style = within(box).getByText('说话方式').closest('.ben-wb__srow') as HTMLElement
    expect(within(style).getByText(/你改过这一项/)).toBeInTheDocument()
    expect(within(box).queryByRole('button', { name: '恢复默认' })).toBeNull()
    fireEvent.click(within(style).getByRole('button', { name: '改' }))
    fireEvent.click(within(box).getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: 'http://x/butler/prompts/reset', body: { name: '说话方式' } }))
  })

  it('哨兵:两列表单,七格各有名字;「开始监视」描边按钮', async () => {
    renderAll()
    const box = await section('哨兵')
    expect(within(box).getByText('变了就提醒你。已有监视项在事务官浮窗查看。')).toBeInTheDocument()
    for (const label of ['盯什么', '目标', '变了跟你说', '检查间隔(秒)', '提醒冷却(秒)', '次数上限', '到期时间']) {
      expect(within(box).getByLabelText(label)).toBeInTheDocument()
    }
    expect(within(box).getByLabelText('变了跟你说').closest('.ben-wb__sfield')).toHaveAttribute('data-full', 'true')
    expect(within(box).getByRole('button', { name: '开始监视' })).toHaveAttribute('data-kind', 'outline')
  })

  it('形象与音色:一行状态 + 「打开配置 ↗」,底下文字「停止服务」;怎么换形象收在折叠里', async () => {
    renderAll()
    const box = await section('形象与音色')
    const row = within(box).getByText('服务运行中').closest('.ben-wb__srow') as HTMLElement
    expect(within(row).getByRole('button', { name: '打开配置 ↗' })).toHaveAttribute('data-kind', 'outline')
    expect(within(box).getByRole('button', { name: '停止服务' })).toHaveAttribute('data-kind', 'text')
    expect(within(box).queryByRole('link')).toBeNull()
    fireEvent.click(within(box).getByText('怎么换形象'))
    expect(within(box).getByRole('link')).toHaveAttribute('href', 'http://127.0.0.1:8792/admin/')
  })

  it('会议转写:一句 + 转写框 + 会议名称;「选择文件」「导入转写」;「或者使用录音文件」才露出录音那一格', async () => {
    renderAll()
    const box = await section('会议转写')
    expect(within(box).getByText('已有转写可以生成纪要与待办。')).toBeInTheDocument()
    expect(within(box).getByPlaceholderText('粘贴转写内容,或选择转写文件')).toBeInTheDocument()
    expect(within(box).getByLabelText('会议名称')).toHaveAttribute('placeholder', '选填')
    expect(within(box).getByText('选择文件')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: '导入转写' })).toHaveAttribute('data-kind', 'outline')
    expect(within(box).queryByLabelText('录音文件在这台电脑上的位置')).toBeNull()
    fireEvent.click(within(box).getByRole('button', { name: '或者使用录音文件' }))
    expect(within(box).getByLabelText('录音文件在这台电脑上的位置')).toBeInTheDocument()
  })

  it('演示数据:一行 + 「放一套」;底下文字「清理演示数据」', async () => {
    renderAll()
    const box = await section('演示数据')
    expect(within(box).getByText('十条虚构事项')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: '放一套' })).toHaveAttribute('data-kind', 'outline')
    expect(within(box).getByRole('button', { name: '清理演示数据' })).toHaveAttribute('data-kind', 'text')
  })
})

describe('手机与座机', () => {
  it('已连接设备:每台一行(名字 · 种类 · 最近连接),「改名」「撤销连接」;底下「添加手机或座机」', async () => {
    const { posts } = renderAll()
    await openGroup(GROUP.devices)
    const box = await section('已连接设备')
    const phone = within(box).getByText('我的手机').closest('.ben-wb__srow') as HTMLElement
    expect(within(phone).getByRole('button', { name: '撤销连接' })).toHaveAttribute('data-kind', 'text')
    expect(within(box).getByText('桌上听筒')).toBeInTheDocument()
    fireEvent.click(within(box).getByRole('button', { name: '添加手机或座机' }))
    await waitFor(() => expect(posts.at(-1)?.url).toBe('http://x/pair/start'))
  })

  it('电脑保持唤醒:一节两行开关;连接状态:局域网一行', async () => {
    renderAll()
    await openGroup(GROUP.devices)
    const awake = await section('电脑保持唤醒')
    await waitFor(() => expect(within(awake).getByRole('checkbox', { name: '工作台开着时,电脑不睡眠' })).toBeChecked())
    expect(within(awake).getByRole('checkbox', { name: '出门时,屏幕保持唤醒' })).not.toBeChecked()
    const lan = await section('连接状态')
    expect(within(lan).getByText('局域网')).toBeInTheDocument()
    expect(within(lan).getByRole('checkbox', { name: '允许手机在局域网访问' })).toBeChecked()
  })
})

describe('各家 AI 与账号', () => {
  it('各家能做什么:一张表(客户端 / 聊天 / 本机文件 / 收回结果),每家一颗「详情」', async () => {
    renderAll()
    await openGroup(GROUP.agents)
    const box = await section('各家能做什么')
    const table = within(box).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map(one => one.textContent)).toEqual(['客户端', '聊天', '本机文件', '收回结果', ''])
    const kimi = within(table).getByRole('row', { name: /Kimi/ })
    expect(within(kimi).getByText('—')).toBeInTheDocument()
    expect(within(table).queryByText('只在网页里聊')).toBeNull()
    fireEvent.click(within(kimi).getByRole('button', { name: '详情' }))
    expect(within(table).getByText(/只在网页里聊/)).toBeInTheDocument()
  })

  it('模型服务:「用工作台提供的服务」一行开关、「使用自己的账号」一行「选择」', async () => {
    renderAll()
    await openGroup(GROUP.agents)
    const box = await section('模型服务')
    await waitFor(() => expect(within(box).getByRole('checkbox', { name: '用工作台提供的服务' })).toBeChecked())
    const own = within(box).getByText('使用自己的账号').closest('.ben-wb__srow') as HTMLElement
    expect(within(own).getByRole('button', { name: '选择' })).toHaveAttribute('data-kind', 'outline')
  })

  it('各家的登录与密钥:接上的每家一行;没接上的收进「暂不可用 N 家 · 展开 ›」', async () => {
    renderAll()
    await openGroup(GROUP.agents)
    const box = await section('各家的登录与密钥')
    await waitFor(() => expect(within(box).getByText('DeepSeek')).toBeInTheDocument())
    expect(within(box).getByText('Claude')).toBeInTheDocument()
    expect(within(box).queryByText('Kimi')).toBeNull()
    fireEvent.click(within(box).getByText('暂不可用 1 家'))
    expect(within(box).getByText('Kimi')).toBeInTheDocument()
    // 填密钥那一格收在「管理」里
    expect(within(box).queryByLabelText('DeepSeek 的密钥')).toBeNull()
    const deepseek = within(box).getByText('DeepSeek').closest('.ben-wb__srow') as HTMLElement
    fireEvent.click(within(deepseek).getByRole('button', { name: '管理' }))
    expect(within(box).getByLabelText('DeepSeek 的密钥')).toBeInTheDocument()
  })

  it('个人访问令牌(稿里没有,保留):一节,每枚一行「撤销」,命令行示例收进折叠', async () => {
    renderAll()
    await openGroup(GROUP.agents)
    const box = await section('个人访问令牌')
    expect(within(box).getByText('本机脚本')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: '撤销 本机脚本' })).toBeInTheDocument()
  })
})

describe('这台电脑', () => {
  it('工作台账号 / 工作布局(两张卡)/ 待办显示(分段)/ 用户层 / 自定义组件', async () => {
    renderAll()
    await openGroup(GROUP.machine)
    const account = await section('工作台账号')
    expect(within(account).getByText('本机维护者')).toBeInTheDocument()
    expect(within(account).getByRole('button', { name: '退出登录' })).toHaveAttribute('data-kind', 'text')

    const layout = await section('工作布局')
    expect(within(layout).getByRole('button', { name: /产品研发/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(layout).getByRole('button', { name: /内容创作/ })).toHaveAttribute('aria-pressed', 'false')
    expect(within(layout).getByText('切换布局不删除自定义组件。')).toBeInTheDocument()

    const today = await section('待办显示')
    expect(within(today).getByRole('button', { name: '卡片' })).toHaveAttribute('aria-pressed', 'true')

    const modules = await section('自定义组件')
    expect(within(modules).getByText('本周数据')).toBeInTheDocument()
    expect(within(modules).queryByText('旧的看板')).toBeNull()
    fireEvent.click(within(modules).getByText('回收站 1 个'))
    expect(within(modules).getByText('旧的看板')).toBeInTheDocument()

    expect(await section('用户层')).toBeInTheDocument()
  })
})

describe('更新', () => {
  it('应用更新 / 运行环境两节', async () => {
    renderAll()
    await openGroup(GROUP.update)
    expect(await section('应用更新')).toBeInTheDocument()
    const runtime = await section('运行环境')
    expect(within(runtime).getByText('没有待切换的环境')).toBeInTheDocument()
  })
})

describe('高级', () => {
  it('目录(名 | 值 | 动作)/ 峰谷时段 / 连接器(文字「卸掉连接器」)/ 体检与引导三行', async () => {
    renderAll()
    await openGroup(GROUP.advanced)
    const paths = await section('目录')
    expect(paths.querySelectorAll('.ben-wb__sdir').length).toBeGreaterThanOrEqual(3)
    expect(within(paths).getByRole('button', { name: '保存目录' })).toHaveAttribute('data-kind', 'outline')

    const peak = await section('峰谷时段')
    expect(within(peak).getByRole('button', { name: '保存时段' })).toHaveAttribute('data-kind', 'outline')

    const connector = await section('连接器')
    expect(within(connector).getByText('工作台连接器')).toBeInTheDocument()
    expect(within(connector).getByRole('button', { name: '卸掉连接器' })).toHaveAttribute('data-kind', 'text')

    const setup = await section('体检与引导')
    expect(within(setup).getByRole('button', { name: '开始体检' })).toHaveAttribute('data-kind', 'outline')
    expect(within(setup).getByRole('button', { name: '重新走一遍首次流程' })).toHaveTextContent('重新走一遍')
    expect(within(setup).getByText('重新设置工作台')).toBeInTheDocument()

    const lab = await section('实验开关')
    expect(within(lab).getAllByRole('checkbox')).toHaveLength(4)
  })
})

/**
 * 七处确认用共用的居中弹层(10-22 统筹定 28;`ui/index.tsx` 的 `ConfirmDialog` + `CONFIRMS`,标题与确认键照评审页):
 * 点了先问,「取消」什么都不发;确认才动手。Esc 只收那一层,设置不跟着关。
 */
describe('七处确认:共用的居中弹层', () => {
  async function confirmFlow(trigger: () => Promise<HTMLElement>, which: { title: string, confirm: string }, sent: string, body: RegExp, posts: { url: string }[]) {
    fireEvent.click(await trigger())
    let dlg = screen.getByRole('dialog', { name: which.title })
    expect(dlg).toHaveTextContent(body)
    const before = posts.length
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: which.title })).toBeNull()
    expect(posts.length).toBe(before)
    fireEvent.click(await trigger())
    dlg = screen.getByRole('dialog', { name: which.title })
    fireEvent.click(within(dlg).getByRole('button', { name: which.confirm }))
    await waitFor(() => expect(posts.map(one => one.url)).toContain(sent))
  }

  it('停止服务 / 清理演示数据', async () => {
    const { posts } = renderAll()
    await confirmFlow(async () => within(await section('形象与音色')).getByRole('button', { name: '停止服务' }), CONFIRMS.stopService, 'http://x/butler/stop', /配置后台打不开/, posts)
    await confirmFlow(async () => within(await section('演示数据')).getByRole('button', { name: '清理演示数据' }), CONFIRMS.clearDemo, 'http://x/demo/clear', /挪进「取消」/, posts)
  })

  it('撤销设备连接(话说清撤的是什么)', async () => {
    const { posts } = renderAll()
    await openGroup(GROUP.devices)
    const box = await section('已连接设备')
    const phone = () => within(box).getByText('我的手机').closest('.ben-wb__srow') as HTMLElement
    await confirmFlow(async () => within(phone()).getByRole('button', { name: '撤销连接' }), CONFIRMS.revokeDevice, 'http://x/pair/revoke', /只撤这台电脑对它的信任/, posts)
  })

  it('退出登录 / 切换布局', async () => {
    const { posts } = renderAll()
    await openGroup(GROUP.machine)
    await confirmFlow(async () => within(await section('工作台账号')).getByRole('button', { name: '退出登录' }), CONFIRMS.logout, 'http://x/account/logout', /回到登录页/, posts)
    await confirmFlow(async () => within(await section('工作布局')).getByRole('button', { name: /内容创作/ }), CONFIRMS.switchLayout, 'http://x/template/apply', /原布局已备份/, posts)
  })

  it('卸掉连接器', async () => {
    const { posts } = renderAll()
    await openGroup(GROUP.advanced)
    await confirmFlow(async () => within(await section('连接器')).getByRole('button', { name: '卸掉连接器' }), CONFIRMS.removeConnector, 'http://x/connector/uninstall', /重新授权/, posts)
  })

  it('撤回做法;Esc 只收确认那一层,设置还开着', async () => {
    const closed: string[] = []
    const server = settingsFetch()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={server.fetchImpl} onClose={() => closed.push('settings')} {...SETTINGS_PROPS} />)
    const one = (await screen.findByText('界面修改,先交给常用的那一家')).closest('.ben-wb__slearn') as HTMLElement
    fireEvent.click(within(one).getByRole('button', { name: '撤回' }))
    expect(screen.getByRole('dialog', { name: CONFIRMS.withdrawHabit.title })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: CONFIRMS.withdrawHabit.title })).toBeNull())
    expect(closed).toEqual([])
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
  })
})

/**
 * 事项类型(10-22 拍板:类型表做成设置;接口 `GET / POST /collab/types`,ui-round-2 出的)。稿里没有这一节,样子照同页的行与两列表单。
 * 只管本机这一份(scope local);工作室共用那一半归卡 C。
 */
describe('这台电脑 · 事项类型', () => {
  it('缺省四类各一行(名字 · 图标 · 暗亮底色);改名、换图标(十六枚一排挑)、换底色,「保存类型表」整张送出', async () => {
    const { posts } = renderAll()
    await openGroup(GROUP.machine)
    const box = await section('事项类型')
    expect(within(box).getByText('本机这一份 · 4 类')).toHaveClass('ben-wb__ss-aside')
    for (const one of DEFAULT_WORK_TYPES) expect(within(box).getByText(one.title)).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: '保存类型表' })).toBeDisabled()

    const meeting = within(box).getByText('会议').closest('.ben-wb__srow') as HTMLElement
    fireEvent.click(within(meeting).getByRole('button', { name: '改' }))
    fireEvent.change(within(box).getByLabelText('名字'), { target: { value: '开会' } })
    fireEvent.click(within(box).getByRole('radio', { name: '对话' }))
    fireEvent.change(within(box).getByLabelText('暗色底'), { target: { value: '#aabbcc' } })
    fireEvent.click(within(box).getByRole('button', { name: '保存类型表' }))
    await waitFor(() => expect(posts.at(-1)?.url).toBe('http://x/collab/types'))
    const sent = (posts.at(-1)!.body as { types: typeof DEFAULT_WORK_TYPES }).types
    expect(sent).toHaveLength(4)
    expect(sent[0]).toEqual({ id: 'meeting', title: '开会', icon: 'messages-square', color: { dark: '#aabbcc', light: '#fff0e3' } })
    expect(sent.slice(1)).toEqual(DEFAULT_WORK_TYPES.slice(1))
  })

  it('加一类、删一类;名字空着不送,说清哪一条哪里不对', async () => {
    const { posts } = renderAll()
    await openGroup(GROUP.machine)
    const box = await section('事项类型')
    fireEvent.click(within(box).getByRole('button', { name: '加一类' }))
    fireEvent.change(within(box).getByLabelText('名字'), { target: { value: '' } })
    fireEvent.click(within(box).getByRole('button', { name: '保存类型表' }))
    expect(within(box).getByRole('alert')).toHaveTextContent('第 5 类的名字要 1–12 个字')
    expect(posts.some(one => one.url === 'http://x/collab/types')).toBe(false)

    fireEvent.change(within(box).getByLabelText('名字'), { target: { value: '复盘' } })
    const routine = within(box).getByText('经营与其他').closest('.ben-wb__srow') as HTMLElement
    fireEvent.click(within(routine).getByRole('button', { name: '删掉「经营与其他」' }))
    fireEvent.click(within(box).getByRole('button', { name: '保存类型表' }))
    await waitFor(() => expect(posts.at(-1)?.url).toBe('http://x/collab/types'))
    const sent = (posts.at(-1)!.body as { types: typeof DEFAULT_WORK_TYPES }).types
    expect(sent.map(one => one.title)).toEqual(['会议', '研发与设计', '内容与推广', '复盘'])
  })

  it('没接类型表(GET /collab/types 404)整节不出现', async () => {
    const server = settingsFetch()
    const fetchImpl = (async (input: unknown, init?: RequestInit) => String(input).includes('/collab/types')
      ? { ok: false, status: 404, json: async () => ({ error: '事项类型表没接上' }) }
      : server.fetchImpl(input as never, init)) as unknown as typeof fetch
    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchImpl} onClose={() => {}} {...SETTINGS_PROPS} />)
    await openGroup(GROUP.machine)
    await screen.findByRole('heading', { name: '工作台账号', level: 3 })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '事项类型', level: 3 })).toBeNull())
  })
})
