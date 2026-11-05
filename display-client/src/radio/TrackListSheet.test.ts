// TrackListSheet 渲染逻辑验证：直接调用组件函数取 React 元素树（无 hooks，纯展示组件，
// 直接调用等价于 React 渲染的第一步）+ renderToStaticMarkup 取文本，不依赖 jsdom/RTL
// （仓库 vitest environment=node，无 DOM 测试基础设施，与 radioState.test.ts 同一路数：纯断言）。
// U3 设备离线（Ben 拿在手里），补这层verify UI 触发入口本身（点曲→onPlayAt(index)）；
// 原生数据链路（setQueue→黑胶卡片进度）T6 已用真机验证过，本文件不重复覆盖。
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { TrackListSheet } from './TrackListSheet.tsx';
import type { RadioTrack } from './radioState.ts';

const T = (id: string, title: string, artist = ''): RadioTrack => (
  { id, uri: `content://x/${id}`, title, artist, album: '', durationMs: 61000 }
);

type AnyEl = ReactElement<Record<string, unknown>>;

/** 递归收集元素树中满足 pred 的节点（React 元素是普通对象，无需渲染器即可遍历）。 */
function collect(node: unknown, pred: (el: AnyEl) => boolean, out: AnyEl[] = []): AnyEl[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out; }
  const el = node as AnyEl;
  if ('props' in el) {
    if (pred(el)) out.push(el);
    collect(el.props.children, pred, out);
  }
  return out;
}

const noop = () => {};
const base = {
  tracks: [] as RadioTrack[],
  currentId: null as string | null,
  onPlayAt: noop,
  onRescan: noop,
  onRequestPermission: noop,
  onClose: noop,
};

describe('TrackListSheet 三空态', () => {
  it('denied：文案提示 + 去授权按钮 onClick 调用 onRequestPermission', () => {
    const onRequestPermission = vi.fn();
    const el = TrackListSheet({ ...base, phase: 'denied', onRequestPermission });
    expect(renderToStaticMarkup(el)).toContain('需要媒体权限');
    const btn = collect(el, (e) => e.type === 'button' && e.props.children === '去授权')[0];
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(onRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('empty：文案提示 + 重新扫描按钮 onClick 调用 onRescan', () => {
    const onRescan = vi.fn();
    const el = TrackListSheet({ ...base, phase: 'empty', onRescan });
    expect(renderToStaticMarkup(el)).toContain('没有找到音乐');
    const btn = collect(el, (e) => e.type === 'button' && e.props.children === '重新扫描')[0];
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it('loading：仅提示文案，body 内无按钮', () => {
    const el = TrackListSheet({ ...base, phase: 'loading' });
    expect(renderToStaticMarkup(el)).toContain('扫描中');
    const body = collect(el, (e) => e.props.className === 'radio-sheet-body')[0];
    expect(collect(body, (e) => e.type === 'button')).toHaveLength(0);
  });
});

describe('TrackListSheet ready 列表', () => {
  it('渲染全部曲目：标题/艺人兜底(未知艺人)/fmtTime 时长格式化', () => {
    const tracks = [T('1', 'Song A', 'Artist A'), T('2', 'Song B')];
    const el = TrackListSheet({ ...base, phase: 'ready', tracks });
    const html = renderToStaticMarkup(el);
    expect(html).toContain('Song A');
    expect(html).toContain('Artist A');
    expect(html).toContain('Song B');
    expect(html).toContain('未知艺人'); // Song B 无 artist，走兜底文案
    expect(html).toContain('1:01'); // fmtTime(61000)
  });

  const isTrackButton = (e: AnyEl) => e.type === 'button' && typeof e.props.className === 'string' && (e.props.className as string).startsWith('radio-track');

  it('currentId 命中的曲目高亮 radio-track--on，其余曲目不高亮', () => {
    const tracks = [T('1', 'Song A'), T('2', 'Song B')];
    const el = TrackListSheet({ ...base, phase: 'ready', tracks, currentId: '2' });
    const buttons = collect(el, isTrackButton);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.props.className).toBe('radio-track');
    expect(buttons[1]!.props.className).toBe('radio-track radio-track--on');
  });

  it('currentId 为 null（无播放中曲目）时无曲目高亮', () => {
    const tracks = [T('1', 'Song A'), T('2', 'Song B')];
    const el = TrackListSheet({ ...base, phase: 'ready', tracks, currentId: null });
    const buttons = collect(el, isTrackButton);
    expect(buttons.every((b) => b.props.className === 'radio-track')).toBe(true);
  });

  it('点击某曲目 → onPlayAt(该曲在全量队列中的索引)——UI 触发入口的核心断言', () => {
    const onPlayAt = vi.fn();
    const tracks = [T('1', 'Song A'), T('2', 'Song B'), T('3', 'Song C')];
    const el = TrackListSheet({ ...base, phase: 'ready', tracks, onPlayAt });
    const buttons = collect(el, isTrackButton);
    expect(buttons).toHaveLength(3);
    (buttons[2]!.props.onClick as () => void)(); // 点第三条（索引 2）
    expect(onPlayAt).toHaveBeenCalledTimes(1);
    expect(onPlayAt).toHaveBeenCalledWith(2);
  });
});

describe('TrackListSheet 头部', () => {
  it('标题显示曲目数；重扫图标按钮→onRescan，关闭按钮→onClose，互不串线', () => {
    const onRescan = vi.fn();
    const onClose = vi.fn();
    const tracks = [T('1', 'A'), T('2', 'B')];
    const el = TrackListSheet({ ...base, phase: 'ready', tracks, onRescan, onClose });
    expect(renderToStaticMarkup(el)).toContain('歌单（2）');
    const rescanBtn = collect(el, (e) => e.type === 'button' && e.props['aria-label'] === '重新扫描')[0];
    (rescanBtn!.props.onClick as () => void)();
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    const closeBtn = collect(el, (e) => e.type === 'button' && e.props.children === '✕')[0];
    (closeBtn!.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRescan).toHaveBeenCalledTimes(1); // 未被关闭按钮误触发
  });
});
