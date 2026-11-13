/**
 * 首页那一条「配置 AI 来源」(2026-11-12):不依赖上一次体检,拿到 /credentials 的真相就画,
 * 而且**直接把 DeepSeek 开放平台的 API Keys 页交给系统浏览器**,同时把整屏引导重新唤起。
 *
 * 顺带钉住「体检缺席(alerts === undefined)」这一档:开源构建上很常见,不能有半格抛错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  AI_SOURCE_MISSING_LINE, DEEPSEEK_KEY_LINE, NeedBar,
} from './NeedBar.tsx';
import { DEEPSEEK_API_KEYS_URL } from './apiKeyGate.ts';

afterEach(() => cleanup());

const noFetch = vi.fn() as unknown as typeof fetch;

function bar(over: Partial<Parameters<typeof NeedBar>[0]> = {}) {
  const props = {
    baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: noFetch,
    onOpenSettings: vi.fn(),
    ...over,
  };
  const view = render(<NeedBar {...props} />);
  return { props, view };
}

const link = (): HTMLAnchorElement => screen.getByRole('link', { name: /配置 AI 来源/ }) as HTMLAnchorElement;

describe('一个 AI 来源都没配时', () => {
  it('体检整格缺席也照样画,主入口直达 API Keys 页', () => {
    const { view } = bar({ aiSourceMissing: true });
    expect(screen.getByText(AI_SOURCE_MISSING_LINE)).toBeTruthy();
    expect(link().getAttribute('href')).toBe(DEEPSEEK_API_KEYS_URL);
    expect(link().getAttribute('target')).toBe('_blank');
    expect(view.container.querySelectorAll('[data-kind="deepseek"]')).toHaveLength(1);
  });

  it('点「配置 AI 来源」:外链照常打开,同时把整屏引导重新唤起', () => {
    const onConfigureAi = vi.fn();
    bar({ aiSourceMissing: true, onConfigureAi });
    fireEvent.click(link());
    expect(onConfigureAi).toHaveBeenCalledTimes(1);
  });

  it('「去设置」那条退路还在', () => {
    const { props } = bar({ aiSourceMissing: true });
    fireEvent.click(screen.getByRole('button', { name: '去设置' }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('体检那条与 /credentials 那条是同一件事,只显示一行,不叠两遍', () => {
    const { view } = bar({ aiSourceMissing: true, alerts: { deepseek_key: true, accessibility: true } });
    expect(view.container.querySelectorAll('[data-kind="deepseek"]')).toHaveLength(1);
    expect(screen.getByText(AI_SOURCE_MISSING_LINE)).toBeTruthy();
  });
});

describe('既有行为不能改坏', () => {
  it('只有体检说缺 Key 时,还是原来那句「你选了用自己的 Key」', () => {
    bar({ alerts: { deepseek_key: true } });
    expect(screen.getByText(DEEPSEEK_KEY_LINE)).toBeTruthy();
    expect(link().getAttribute('href')).toBe(DEEPSEEK_API_KEYS_URL);
  });

  it('什么都没缺、体检也没来过 → 一条横幅都不画', () => {
    const { view } = bar();
    expect(view.container.querySelector('.ben-wb__needbar')).toBeNull();
  });

  it('体检缺席但报了别的项(辅助功能)时,那一行照旧画,模型服务那格不炸', () => {
    const { view } = bar({ alerts: { accessibility: true } });
    expect(view.container.querySelector('[data-kind="accessibility"]')).not.toBeNull();
    expect(view.container.querySelector('.ben-wb__needbar')).not.toBeNull();
  });
});
