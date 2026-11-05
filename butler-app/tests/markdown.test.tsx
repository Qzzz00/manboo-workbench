/**
 * 手机上把对话里的 Markdown 按格式显示(2026-10-01,手机读对话卡 B)。
 *
 * 自己写的一小段:直接出 React 元素,**不走 innerHTML**(对话里的东西不可信,一段 `<img onerror>` 不该在她手机上跑),
 * 也不加依赖(C4 供应链)。认得:标题、段落、粗体 / 斜体 / 行内代码、代码块、引用、有序 / 无序列表(含嵌套)、
 * 表格(能横滑)、分隔线、链接(只认 http(s),别的照字显示)。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/ui/Markdown';

function html(text: string): HTMLElement {
  return render(<Markdown text={text} />).container;
}

describe('Markdown', () => {
  it('★标题、粗体、斜体、行内代码、段落', () => {
    const c = html('# 结论\n\n**大约 16:30** 能用上,*先*跑 `pnpm test`。\n第二行');
    expect(c.querySelector('h1')?.textContent).toBe('结论');
    expect(c.querySelector('strong')?.textContent).toBe('大约 16:30');
    expect(c.querySelector('em')?.textContent).toBe('先');
    expect(c.querySelector('code')?.textContent).toBe('pnpm test');
    expect(c.querySelector('p')?.textContent).toContain('第二行');
    expect(c.querySelector('p br')).not.toBeNull();
  });

  it('代码块原样(等宽、不解析里面的记号),带语言', () => {
    const c = html('看这段:\n\n```ts\nconst a = **b**\n<script>x</script>\n```\n');
    const pre = c.querySelector('pre');
    expect(pre?.textContent).toBe('const a = **b**\n<script>x</script>');
    expect(pre?.getAttribute('data-lang')).toBe('ts');
    expect(c.querySelector('script')).toBeNull();
  });

  it('列表(有序、无序、嵌套)与引用', () => {
    const c = html('- 一\n- 二\n  - 二点一\n\n1. 甲\n2. 乙\n\n> 引一句');
    expect(c.querySelectorAll('ul > li')).toHaveLength(3);
    expect(c.querySelector('ul ul li')?.textContent).toBe('二点一');
    expect([...c.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['甲', '乙']);
    expect(c.querySelector('blockquote')?.textContent).toBe('引一句');
  });

  it('★表格:表头与行,包在能横滑的框里', () => {
    const c = html('| 项 | 状态 |\n|---|:---:|\n| A | **好** |\n| B | 坏 |');
    expect([...c.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['项', '状态']);
    expect([...c.querySelectorAll('tbody tr')].map((tr) => tr.textContent)).toEqual(['A好', 'B坏']);
    expect(c.querySelector('.ba-md__table')).not.toBeNull();
  });

  it('★不跑任何 HTML:标签照字显示;链接只认 http(s)', () => {
    const c = html('<img src=x onerror=alert(1)> [官网](https://example.com) [坏的](javascript:alert(1))');
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = [...c.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
    expect(c.textContent).toContain('坏的');
  });

  it('分隔线;空文本不画东西', () => {
    expect(html('上\n\n---\n\n下').querySelector('hr')).not.toBeNull();
    expect(html('').textContent).toBe('');
  });
});
