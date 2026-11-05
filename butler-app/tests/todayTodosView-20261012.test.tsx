/**
 * 手机上「今天的待办」的两种显示与换版本那一下(2026-10-12,周三演示)。与电脑那一格一致:
 * 按日期汇总 = 今天 / 明天 / 更晚三组带件数;不汇总 = 今天那一条清单;版本变了先盖「正在优化…」,到点再换。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TodayTodos, TODAY_VEIL_FADE_MS } from '../src/items/TodayTodos';
import { TODAY_SWITCH_MS, TODAY_SWITCH_TEXT, type TodayTodosView, type TodayViewStyle } from '../src/api/protocol';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function viewOf(style: TodayViewStyle | undefined): TodayTodosView {
  const a = { id: 'a', title: '回三条评论', due: '2026-10-12', done: false, overdue: false };
  const b = { id: 'b', title: '剪片头', due: '2026-10-13', done: false, overdue: false };
  return {
    date: '2026-10-12', tomorrow: '2026-10-13', items: [a],
    ...(style === undefined ? {} : { style }),
    groups: [
      { key: 'today', label: '今天', items: [a] },
      { key: 'tomorrow', label: '明天', items: [b] },
      { key: 'later', label: '更晚', items: [] },
    ],
  };
}

describe('两种显示', () => {
  it('按日期汇总:三组标题带件数', () => {
    render(<TodayTodos view={viewOf('by_date')} onOpen={() => {}} />);
    expect(screen.getByText('今天 · 1 件')).toBeTruthy();
    expect(screen.getByText('明天 · 1 件')).toBeTruthy();
    expect(screen.getByText('更晚 · 0 件')).toBeTruthy();
    expect(screen.getByText('剪片头')).toBeTruthy();
  });

  it('不汇总 / 老工作台没报 style:今天那一条清单', () => {
    render(<TodayTodos view={viewOf(undefined)} onOpen={() => {}} />);
    expect(screen.getByText('回三条评论')).toBeTruthy();
    expect(screen.queryByText('剪片头')).toBeNull();
  });
});

describe('换版本那一下', () => {
  it('先盖「正在优化…」,到点换成新版、遮罩淡出', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TodayTodos view={viewOf('flat')} onOpen={() => {}} />);
    rerender(<TodayTodos view={viewOf('by_date')} onOpen={() => {}} />);
    expect(screen.getByText(TODAY_SWITCH_TEXT)).toBeTruthy();
    expect(screen.queryByText('明天 · 1 件')).toBeNull();
    act(() => { vi.advanceTimersByTime(TODAY_SWITCH_MS); });
    expect(screen.getByText('明天 · 1 件')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(TODAY_VEIL_FADE_MS); });
    expect(screen.queryByText(TODAY_SWITCH_TEXT)).toBeNull();
  });
});

describe('对照电脑那边', () => {
  it('遮罩时长、那一行字、两版的名字与 workbench-plugin/src/protocol.ts 一个不差', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts'), 'utf8');
    expect(src).toContain(`export const TODAY_SWITCH_MS = ${TODAY_SWITCH_MS}\n`);
    expect(src).toContain(`export const TODAY_SWITCH_TEXT = '${TODAY_SWITCH_TEXT}'\n`);
    expect(src).toContain("export const TODAY_VIEWS = ['by_date', 'flat'] as const");
  });
});
