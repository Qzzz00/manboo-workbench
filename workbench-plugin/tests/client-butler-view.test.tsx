/**
 * 事务官浮窗的两态渲染(W4)。
 *
 * **这个文件承载不可改清单第 1 条的钉死断言**:AI 悬浮窗不可消失,必须永远有叫停入口。
 * 「全部暂停」在任何一态下都必须在渲染树里——不靠提示词,靠这里的断言。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Butler, type ButlerProps } from '../src/client/Butler.tsx'
import { STYLE } from '../src/client/style.ts'
import { MIN_BUTLER_W_PX } from '../src/protocol.ts'
import type { BriefView } from '../src/protocol.ts'

afterEach(cleanup)

function props(over: Partial<ButlerProps> = {}): ButlerProps {
  return {
    conclusions: [],
    corner: 'br',
    min: false,
    narrowForced: false,
    paused: false,
    testRinging: false,
    onToggleMin: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onPause: vi.fn(),
    onTestRing: vi.fn(),
    onDismissBrief: vi.fn(),
    onAsk: vi.fn(async () => true),
    onCancelWatch: vi.fn(),
    ...over,
  }
}

describe('不可改清单第 1 条:叫停入口在两态下都可用(展开在抽屉/按钮行,收起在球右键或长按)', () => {
  it('展开态:「全部暂停」与「试铃」可见', () => {
    render(<Butler {...props({ min: false })} />)
    expect(screen.getByRole('button', { name: /全部暂停|恢复/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /试铃|停铃/ })).toBeInTheDocument()
  })

  it('收起态(球):右键呼出叫停入口「全部暂停」与「试铃」', async () => {
    render(<Butler {...props({ min: true })} />)
    const ball = screen.getByRole('button', { name: /事务官.*展开/ })
    fireEvent.contextMenu(ball)
    expect(await screen.findByRole('button', { name: /全部暂停|恢复/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /试铃|停铃/ })).toBeInTheDocument()
  })
})

describe('只留两态(球 / 展开最小尺寸),没有中间态', () => {
  it('展开态:有收起入口,点击收起为球', () => {
    const onToggleMin = vi.fn()
    render(<Butler {...props({ min: false, onToggleMin })} />)
    const collapseBtn = screen.getByRole('button', { name: /收起/ })
    fireEvent.click(collapseBtn)
    expect(onToggleMin).toHaveBeenCalled()
  })

  it('收起态:只是一颗球,不另加标题栏文字框,点击球触发展开', () => {
    const onToggleMin = vi.fn()
    render(<Butler {...props({ min: true, onToggleMin })} />)
    // 收起态没有标题栏文字按钮「.ben-wb__butler-head」
    expect(screen.queryByRole('button', { name: '事务官' })).toBeNull()
    // 只有球(带有展开提示)
    const ball = screen.getByLabelText(/事务官.*(展开|\(点一下展开\))/)
    fireEvent.click(ball)
    expect(onToggleMin).toHaveBeenCalled()
  })

  it('收起态没有拉伸手柄', () => {
    render(<Butler {...props({ min: true })} />)
    expect(screen.queryByLabelText('拉伸事务官浮窗')).toBeNull()
  })
})

describe('可拉伸之下,叫停入口仍然不可能被拉没(W4)', () => {
  it('存档里塞一个荒谬的小尺寸:渲染时抬回下限,「全部暂停」仍在', () => {
    render(<Butler {...props({ size: { w_px: 1, h_px: 1 } })} />)
    const aside = screen.getByLabelText('事务官')
    expect(aside).toHaveStyle({ width: `${MIN_BUTLER_W_PX}px` })
    expect(screen.getByRole('button', { name: /全部暂停/ })).toBeInTheDocument()
  })

  it('存档里塞一个越界坐标:渲染时收回视口内', () => {
    render(<Butler {...props({ pos: { x_pct: 99, y_pct: 99 }, size: { w_px: 250, h_px: 200 } })} />)
    const aside = screen.getByLabelText('事务官')
    const left = Number.parseFloat((aside as HTMLElement).style.left)
    expect(left * (window.innerWidth / 100) + 250).toBeLessThanOrEqual(window.innerWidth)
  })

  it('窄条态没有拉伸手柄', () => {
    render(<Butler {...props({ narrowForced: true })} />)
    expect(screen.queryByLabelText('拉伸事务官浮窗')).toBeNull()
  })
})

describe('修复轮 1(Critical):按钮行不参与收缩的样式规则还在', () => {
  /**
   * **这条断言的能力边界,读的人务必看清楚**:jsdom 不做真实布局(不计算 flex 的
   * 实际像素高度、不模拟 overflow 裁切),所以它证不了"按钮真的可见"——评审那条
   * Critical 就是 jsdom 测试全绿、真实浏览器截图却看不见按钮,才被发现的。这条测试
   * 只能证明"CSS 字符串里 .ben-wb__butler-acts 还带着 flex:0 0 auto"这一件事,防的是
   * 后人在重构时把这条规则顺手删掉/改回默认值。**可见性的证据在 task-5-report.md
   * 里的真实浏览器截图,不在这条断言里**——不要把这条测试当成"可见性已经被测试覆盖"
   * 的理由。
   */
  it('.ben-wb__butler-acts 带 flex:0 0 auto——空间不够时先收缩的是文案区,不是按钮行', () => {
    expect(STYLE).toMatch(/\.ben-wb__butler-acts\{[^}]*flex:0 0 auto[^}]*\}/)
  })

  it('.ben-wb__butler-text 能收缩到 0 并自己滚动——不靠挤按钮腾地方', () => {
    expect(STYLE).toMatch(/\.ben-wb__butler-text\{[^}]*min-height:0[^}]*\}/)
    expect(STYLE).toMatch(/\.ben-wb__butler-text\{[^}]*overflow-y:auto[^}]*\}/)
  })
})

const BRIEF: BriefView = {
  date: '2026-08-25',
  push: true,
  topics: [
    { id: 'd1', section: '今日资讯', title: 'MetaRoCE 发布', summary: '摘要一', url: 'https://a.example', source: 'Meta', tier: 'flash' },
    { id: 'd2', section: '今日资讯', title: 'GPT-5.6 登陆 Kiro', summary: '摘要二', url: 'https://b.example', source: 'IT之家', tier: 'flash' },
  ],
}

describe('今晨快报进浮窗(W4)', () => {
  it('有条目:全部列出,不截断——浮窗可拉伸,拉多大看多少', () => {
    render(<Butler {...props({ brief: BRIEF })} />)
    expect(screen.getByText('MetaRoCE 发布')).toBeInTheDocument()
    expect(screen.getByText('GPT-5.6 登陆 Kiro')).toBeInTheDocument()
  })

  it('标题是指向原文的外链', () => {
    render(<Butler {...props({ brief: BRIEF })} />)
    const link = screen.getByRole('link', { name: 'MetaRoCE 发布' })
    expect(link).toHaveAttribute('href', 'https://a.example')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('没有内容源:整块不渲染,不摆空壳', () => {
    render(<Butler {...props({ brief: { date: '2026-08-25', push: false, topics: [] } })} />)
    expect(screen.queryByText('今晨快报')).toBeNull()
  })

  it('brief 整个缺省(服务端没启用):同样不渲染', () => {
    render(<Butler {...props()} />)
    expect(screen.queryByText('今晨快报')).toBeNull()
  })

  it('取数失败:如实说原因,不编内容', () => {
    render(<Butler {...props({ brief: { date: '2026-08-25', push: false, topics: [], error: '连不上' } })} />)
    expect(screen.getByText(/今天没取到快报/)).toBeInTheDocument()
    expect(screen.getByText(/连不上/)).toBeInTheDocument()
  })

  it('划走触发 onDismissBrief', async () => {
    const onDismissBrief = vi.fn()
    render(<Butler {...props({ brief: BRIEF, onDismissBrief })} />)
    await userEvent.click(screen.getByRole('button', { name: '划走今晨快报' }))
    expect(onDismissBrief).toHaveBeenCalledTimes(1)
  })

  /**
   * 终审 C3(合并前必修):渲染条件必须看 dismissed。
   * 在此之前只看 `topics.length > 0 || error !== undefined`,服务端记下的
   * dismissed 没有任何客户端消费者——点 ✕ 之后下一拍回来的 topics 一条不少,
   * 界面纹丝不动,那个按钮等于是假的。
   */
  it('C3:服务端说这份已经被划走 → 整块不渲染(✕ 真的划得走)', () => {
    render(<Butler {...props({ brief: { ...BRIEF, dismissed: true } })} />)
    expect(screen.queryByText('今晨快报')).toBeNull()
    expect(screen.queryByText('MetaRoCE 发布')).toBeNull()
  })

  it('C3:划走的是内容,不是错误态——取数失败那行照常如实显示', () => {
    render(<Butler {...props({
      brief: { date: '2026-08-25', push: false, topics: [], error: '连不上', dismissed: true },
    })} />)
    expect(screen.getByText(/今天没取到快报/)).toBeInTheDocument()
  })

  it('收起态(球)不显示快报(右键呼出叫停入口仍在)', () => {
    render(<Butler {...props({ brief: BRIEF, min: true })} />)
    expect(screen.queryByText('MetaRoCE 发布')).toBeNull()
    const ball = screen.getByRole('button', { name: /事务官.*展开/ })
    fireEvent.contextMenu(ball)
    expect(screen.getByRole('button', { name: /全部暂停/ })).toBeInTheDocument()
  })

  // 修复轮 1(评审 Important):WidgetsModule.tsx 里那张待退休的空壳快报卡也用
  // id="ben-wb-brief"(<h2 id="ben-wb-brief">)——它和 Butler 同属一棵 DOM 树
  // (事务官是独立挂载的浮窗,widgets 是模块网格里的常规模块,俩都在同一个 <main> 下),
  // 事务官展开且有快报、widgets 模块又可见时,页面上会出现两个同 id 的 <h2>,
  // getElementById 只认第一个匹配,aria-labelledby 就可能解析到别处的标题。
  // 这里不重渲染 WidgetsModule(它们不在同一层级,凑不到一起),只锁两件事:
  // Butler 这侧的 id 不再是会撞车的 'ben-wb-brief',以及 aria-labelledby 真的
  // 关联到了 Butler 自己这个标题(用 role 查询验证关联本身成立,不只是比字符串)。
  it('快报标题的 id 不与 WidgetsModule 的空壳卡撞车,aria-labelledby 关联到自己', () => {
    render(<Butler {...props({ brief: BRIEF })} />)
    const heading = screen.getByText('今晨快报')
    expect(heading.id).not.toBe('ben-wb-brief')
    expect(screen.getByRole('region', { name: '今晨快报' })).toBeInTheDocument()
  })
})

describe('提议区进浮窗(W4)', () => {
  it('展开态:显示如实空态', () => {
    render(<Butler {...props()} />)
    expect(screen.getByText('工作台自己的提议')).toBeInTheDocument()
    expect(screen.getByText(/证据不足,暂不提议/)).toBeInTheDocument()
  })

  it('收起态:不显示提议区(右键呼出叫停入口仍在)', () => {
    render(<Butler {...props({ min: true })} />)
    expect(screen.queryByText('工作台自己的提议')).toBeNull()
    const ball = screen.getByRole('button', { name: /事务官.*展开/ })
    fireEvent.contextMenu(ball)
    expect(screen.getByRole('button', { name: /全部暂停/ })).toBeInTheDocument()
  })

  // 同一个坑,第二次踩之前先避开:WidgetsModule.tsx 里那张待退休的提议卡也叫
  // aria-labelledby="ben-wb-prop"(<h2 id="ben-wb-prop">),跟 Butler 同挂在一棵
  // DOM 树上(事务官是独立挂载的浮窗,widgets 是模块网格里的常规模块,同属一个
  // <main>)。这里不重渲染 WidgetsModule(层级凑不到一起),只锁两件事:Butler
  // 这侧的 id 不是会撞车的 'ben-wb-prop',以及 aria-labelledby 真的关联到了
  // Butler 自己这个标题(用 role 查询验证关联本身成立,不只是比字符串)。
  it('提议区标题的 id 不与 WidgetsModule 的提议卡撞车,aria-labelledby 关联到自己', () => {
    render(<Butler {...props()} />)
    const heading = screen.getByText('工作台自己的提议')
    expect(heading.id).not.toBe('ben-wb-prop')
    expect(screen.getByRole('region', { name: '工作台自己的提议' })).toBeInTheDocument()
  })
})

describe('浮窗的对话入口(W4)', () => {
  it('回车:把文本交给 onAsk,成功后清空输入框并如实提示「已复制」', async () => {
    const onAsk = vi.fn(async () => true)
    render(<Butler {...props({ onAsk })} />)
    const input = screen.getByLabelText('跟事务官说一句')
    await userEvent.type(input, '帮我看看 Aiboo 卡在哪{Enter}')

    expect(onAsk).toHaveBeenCalledWith('帮我看看 Aiboo 卡在哪')
    await waitFor(() => expect(input).toHaveValue(''))
    expect(screen.getByText(/已复制/)).toBeInTheDocument()
  })

  it('剪贴板写失败:不清空输入框,如实说没能复制——不谎称已发给事务官', async () => {
    const onAsk = vi.fn(async () => false)
    render(<Butler {...props({ onAsk })} />)
    const input = screen.getByLabelText('跟事务官说一句')
    await userEvent.type(input, '一句话{Enter}')

    await waitFor(() => expect(screen.getByText(/没能复制/)).toBeInTheDocument())
    expect(input).toHaveValue('一句话')
  })

  it('空白输入:什么都不做', async () => {
    const onAsk = vi.fn(async () => true)
    render(<Butler {...props({ onAsk })} />)
    await userEvent.type(screen.getByLabelText('跟事务官说一句'), '   {Enter}')
    expect(onAsk).not.toHaveBeenCalled()
  })

  it('界面上不出现「已发送」这类谎话', async () => {
    const onAsk = vi.fn(async () => true)
    render(<Butler {...props({ onAsk })} />)
    await userEvent.type(screen.getByLabelText('跟事务官说一句'), 'x{Enter}')
    await waitFor(() => expect(screen.getByText(/已复制/)).toBeInTheDocument())
    expect(screen.queryByText(/已发送|已发给事务官/)).toBeNull()
  })

  it('收起态没有输入框(右键呼出叫停入口仍在)', () => {
    render(<Butler {...props({ min: true })} />)
    expect(screen.queryByLabelText('跟事务官说一句')).toBeNull()
    const ball = screen.getByRole('button', { name: /事务官.*展开/ })
    fireEvent.contextMenu(ball)
    expect(screen.getByRole('button', { name: /全部暂停/ })).toBeInTheDocument()
  })
})

/**
 * C2(整分支终审,合并前必修 · 不可改清单第 1 条)。
 *
 * `size` 是 W4 新加的字段,**所有旧存档都没有**;而 `pos`(A6 加的自由拖动坐标)Ben
 * 早就在用。老写法在 `size===undefined` 时拿 MIN_BUTLER_W/H_PX(200×80)当浮窗尺寸
 * 去算位置夹紧,可真正渲染出来的是 CSS 的 250px 宽 + 内容撑出来的高度(展开态带 20 条
 * 快报时终审在 1400×900 真实浏览器里量到 250×887)——夹紧算出来的落位因此把浮窗
 * 底部整个推出了下沿,「全部暂停」出视口 795.8px,elementFromPoint 返回 null(点不到)。
 * 升级后第一次打开就命中,不是边角场景。
 *
 * 既有的几何用例每次都显式传了 `size`,恰好绕开这条分支——所以要单独钉一条。
 * **jsdom 不做布局**,getBoundingClientRect 恒为 0,不喂真实尺寸的话这条用例在修与
 * 不修两种情况下都恒绿(那就等于没测)。这里喂的正是终审真机量到的那组数。
 */
describe('C2:只有 pos、没有 size 的旧存档,叫停入口也不能被推出视口', () => {
  const ORIGINAL_W = window.innerWidth
  const ORIGINAL_H = window.innerHeight

  function setViewport(w: number, h: number): void {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true })
  }

  /** 让 getBoundingClientRect 回一个"真实浏览器里会量到"的尺寸。 */
  function stubRenderedSize(w: number, h: number): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON() {},
    } as DOMRect)
  }

  afterEach(() => {
    vi.restoreAllMocks()
    setViewport(ORIGINAL_W, ORIGINAL_H)
  })

  it('pos 越界 + 不传 size:按实际渲染尺寸(250×887)夹回视口内,整个浮窗都在屏幕上', () => {
    setViewport(1400, 900)
    stubRenderedSize(250, 887)
    render(<Butler {...props({ pos: { x_pct: 95, y_pct: 95 } })} />)

    const aside = screen.getByLabelText('事务官')
    const leftPx = Number.parseFloat(aside.style.left) * 1400 / 100
    const topPx = Number.parseFloat(aside.style.top) * 900 / 100
    // 下沿/右沿都不出界——「全部暂停」在浮窗底部那一行,浮窗整个在视口内它才可能可点。
    expect(topPx + 887).toBeLessThanOrEqual(900)
    expect(leftPx + 250).toBeLessThanOrEqual(1400)
  })

  it('★ 夹位置只在渲染时算、不回写:越界的 pos 渲染上夹回视口,但绝不发 onMove(2026-10-28,反复开合的环)', async () => {
    setViewport(1400, 900)
    stubRenderedSize(250, 887)
    const onMove = vi.fn()
    render(<Butler {...props({ pos: { x_pct: 95, y_pct: 95 }, onMove })} />)

    // 渲染上确实夹了(这条不变,上面那条用例钉得更细)。
    const aside = screen.getByLabelText('事务官')
    expect(Number.parseFloat(aside.style.top) * 900 / 100 + 887).toBeLessThanOrEqual(900)
    // 但一行持久化都不发:回写就是 POST → 回声 → 再 POST 那个环的发动机(交接-1027
    // 「12:0x 气泡」)。onMove 只剩拖拽一个调用方。
    await new Promise(resolve => setTimeout(resolve, 50)) // 给"万一真发了"留够反应时间
    expect(onMove).not.toHaveBeenCalled()
  })

  it('位置本来就装得下:不发多余的 onMove(别把好好的存档改来改去)', async () => {
    setViewport(1400, 900)
    stubRenderedSize(250, 300)
    const onMove = vi.fn()
    render(<Butler {...props({ pos: { x_pct: 10, y_pct: 10 }, onMove })} />)

    await new Promise(resolve => setTimeout(resolve, 50)) // 给"万一真发了"留够反应时间
    expect(onMove).not.toHaveBeenCalled()
  })
})

// 10-22 统筹第三轮回话(维护者:「那个球体也是粒子球?」):收起态必须是 ButlerInbox 那一颗
// ParticleOrb——同一个组件、同一份外观设置来源,不是老的纯 CSS 声纹球(Orb.tsx)。
describe('球态渲染 ParticleOrb(与事务官页同一颗)', () => {
  it('球态里是 ParticleOrb:粒子球外壳在球按钮里(老声纹球组件已从浮窗消失)', () => {
    const { container } = render(<Butler {...props({ min: true })} />)
    const ballBtn = container.querySelector('.ben-wb__butler-ball-btn')
    expect(ballBtn).not.toBeNull()
    // jsdom 没有 Canvas 2D,ParticleOrb 初始化失败会退回它内置的兜底球,但兜底球也长在
    // 粒子球外壳(.ben-wb__particle-orb)里——外壳存在即证明这里渲染的是 ParticleOrb。
    expect(ballBtn!.querySelector('.ben-wb__particle-orb')).not.toBeNull()
  })

  it('试铃照 ButlerInbox 的同一格映射:提示色 confirmation(琥珀),mode 不变', () => {
    const { container } = render(<Butler {...props({ min: true, testRinging: true })} />)
    expect(container.querySelector('.ben-wb__butler-ball-btn .ben-wb__particle-orb[data-notice=confirmation]')).not.toBeNull()
  })

  it('没试铃:提示色 neutral', () => {
    const { container } = render(<Butler {...props({ min: true })} />)
    expect(container.querySelector('.ben-wb__butler-ball-btn .ben-wb__particle-orb[data-notice=neutral]')).not.toBeNull()
  })
})

// 10-22 第三轮 2(维护者):浮窗里直接放窗口槽里那页事务官(同一个组件,两个入口),不再单独维护一套话;
// 收成窄条时照旧只留标题与「全部暂停 / 试铃」(不可改清单第 1 条:永远有叫停入口)。
describe('浮窗里放那页事务官', () => {
  it('给了 page:展开时身里就是那一页,老那套话不画;收成窄条时照旧是叫停与试铃', () => {
    const { rerender } = render(<Butler {...props({ conclusions: ['工作台 按当前速度赶不上 10-4'], page: <div>事务官那一页</div> })} />)
    expect(screen.getByText('事务官那一页')).toBeInTheDocument()
    expect(screen.queryByText('工作台 按当前速度赶不上 10-4')).toBeNull()
    rerender(<Butler {...props({ min: true, page: <div>事务官那一页</div> })} />)
    expect(screen.queryByText('事务官那一页')).toBeNull()
    const ball = screen.getByRole('button', { name: /事务官.*展开/ })
    fireEvent.contextMenu(ball)
    expect(screen.getByRole('button', { name: /暂停/ })).toBeInTheDocument()
  })
})
