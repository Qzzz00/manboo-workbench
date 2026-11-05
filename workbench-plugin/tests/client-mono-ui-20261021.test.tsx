/**
 * 视觉 A 的常用组件(2026-10-21,`src/client/ui/`):按钮、输入、开关、下拉、标签、卡片、列表行、弹层、空态、计数点列、刻度条。
 * 钉住行为与语义:一点一件、0 明示不补装饰点;刻度一格 5%,最后一格按比例;空态只有一个操作;开关是 switch。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, Card, DotTally, Empty, Popover, Row, Rungs, Select, StackRungs, Tag, TextArea, TextField, Toggle, rungFills, stackRungs } from '../src/client/ui/index.tsx'
import { UI_STYLE } from '../src/client/ui/uiStyle.ts'

afterEach(cleanup)

describe('按钮', () => {
  it('缺省次级,主按钮标 data-variant=primary;禁用不触发', () => {
    const onClick = vi.fn()
    render(<><Button onClick={onClick}>记下</Button><Button variant="primary" disabled onClick={onClick}>保存</Button></>)
    expect(screen.getByRole('button', { name: '记下' }).dataset.variant).toBe('secondary')
    const save = screen.getByRole('button', { name: '保存' })
    expect(save.dataset.variant).toBe('primary')
    fireEvent.click(save)
    fireEvent.click(screen.getByRole('button', { name: '记下' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '记下' }).getAttribute('type')).toBe('button')
  })
})

describe('输入、下拉、开关', () => {
  it('输入框与多行输入带标签', () => {
    render(<><TextField label="称呼" value="" onChange={() => {}} /><TextArea label="补充交代" value="x" onChange={() => {}} /></>)
    expect(screen.getByLabelText('称呼').className).toContain('wb-ui-field')
    expect((screen.getByLabelText('补充交代') as HTMLTextAreaElement).value).toBe('x')
  })

  it('开关是 switch,点一下翻转', () => {
    const onChange = vi.fn()
    render(<Toggle label="保持唤醒" checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: '保持唤醒' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('下拉列出选项', () => {
    const onChange = vi.fn()
    render(<Select label="范围" value="all" options={[{ value: 'all', label: '全部' }, { value: 'me', label: '只看我' }]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('范围'), { target: { value: 'me' } })
    expect(onChange).toHaveBeenCalledWith('me')
  })
})

describe('标签、卡片、列表行、弹层', () => {
  it('标签是纯文字,不是按钮', () => {
    render(<Tag>验证中</Tag>)
    expect(screen.getByText('验证中').tagName).toBe('SPAN')
  })

  it('卡片有标题与右上角', () => {
    render(<Card title="随手记" aside={<span>3 条随记</span>}>body</Card>)
    expect(screen.getByRole('heading', { name: '随手记' })).toBeTruthy()
    expect(screen.getByText('3 条随记')).toBeTruthy()
  })

  it('列表行:标题、状态副行、动作;能点就是按钮', () => {
    const onClick = vi.fn()
    render(<Row title="记住的规矩" sub="3 条正在照做" action="管理规矩" onClick={onClick} />)
    const row = screen.getByRole('button', { name: /记住的规矩/ })
    expect(row.textContent).toContain('3 条正在照做')
    expect(row.textContent).toContain('管理规矩')
    fireEvent.click(row)
    expect(onClick).toHaveBeenCalled()
  })

  it('弹层关着不渲染,开着是对话框,Esc 关', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Popover open={false} label="说明" onClose={onClose}>里</Popover>)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<Popover open label="说明" onClose={onClose}>里</Popover>)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '说明' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('空态', () => {
  it('一句结论、一句引导、一个操作', () => {
    const onAction = vi.fn()
    render(<Empty title="还没有随记" hint="想到什么先记一句。" action="记一条" onAction={onAction} />)
    expect(screen.getByText('还没有随记')).toBeTruthy()
    expect(screen.getByText('想到什么先记一句。')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '记一条' }))
    expect(onAction).toHaveBeenCalled()
  })
})

describe('计数点列', () => {
  it('一点一件', () => {
    const { container } = render(<DotTally count={3} label="推进" />)
    expect(container.querySelectorAll('.wb-ui-dot')).toHaveLength(3)
    expect(screen.getByLabelText('推进 3')).toBeTruthy()
  })

  it('0 明示,不补装饰点', () => {
    const { container } = render(<DotTally count={0} label="验证" />)
    expect(container.querySelectorAll('.wb-ui-dot')).toHaveLength(0)
    expect(screen.getByLabelText('验证 0')).toBeTruthy()
  })

  it('超过上限画满上限,余数写成 +n', () => {
    const { container } = render(<DotTally count={45} max={40} label="记录" />)
    expect(container.querySelectorAll('.wb-ui-dot')).toHaveLength(40)
    expect(container.textContent).toContain('+5')
  })
})

describe('刻度条', () => {
  it('一格 5%,最后一格按比例', () => {
    const fills = rungFills(62)
    expect(fills).toHaveLength(20)
    expect(fills.slice(0, 12).every(one => one === 1)).toBe(true)
    expect(fills[12]).toBeCloseTo(0.4)
    expect(fills.slice(13).every(one => one === 0)).toBe(true)
  })

  it('越界夹住;0 与 100 都画出来', () => {
    expect(rungFills(-3).every(one => one === 0)).toBe(true)
    expect(rungFills(130).every(one => one === 1)).toBe(true)
    const { container } = render(<Rungs percent={0} label="Kimi 5 小时余量" />)
    expect(container.querySelectorAll('.wb-ui-rung')).toHaveLength(20)
    expect(screen.getByLabelText('Kimi 5 小时余量 0%')).toBeTruthy()
  })
})

describe('构成刻度', () => {
  it('按占比分格(最大余数),格数总和不变,0 份不占格', () => {
    expect(stackRungs([60, 30, 10], 10)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 2])
    expect(stackRungs([1, 1, 1], 10)).toHaveLength(10)
    expect(stackRungs([5, 0], 4)).toEqual([0, 0, 0, 0])
    expect(stackRungs([0, 0], 4)).toEqual([])
  })

  it('一份至少一格(有就画得出来)', () => {
    expect(stackRungs([990, 10], 20).filter(one => one === 1)).toHaveLength(1)
  })

  it('图例按份写名字;明度按先后', () => {
    const { container } = render(<StackRungs label="构成" parts={[{ label: 'Codex', value: 6 }, { label: 'Claude', value: 3 }, { label: '其他', value: 1 }]} cells={10} />)
    expect(container.querySelectorAll('.wb-ui-srung')).toHaveLength(10)
    expect(container.querySelectorAll('.wb-ui-srung[data-part="0"]')).toHaveLength(6)
    expect(screen.getByRole('img', { name: '构成 Codex 60% · Claude 30% · 其他 10%' })).toBeTruthy()
  })
})

describe('样式只读令牌', () => {
  it('组件样式里没有写死的颜色', () => {
    expect(UI_STYLE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(UI_STYLE).not.toMatch(/rgba?\(/)
  })
})
