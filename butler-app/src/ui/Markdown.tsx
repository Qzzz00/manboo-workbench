/**
 * 对话里的 Markdown 按格式显示(2026-10-01,手机读对话卡 B)。
 *
 * 为什么自己写、不加依赖:对话内容不可信(AI 回的、她贴的、网页抓来的都有),这里**只出 React 元素,不走 innerHTML**,
 * 一段 `<img onerror>` 在这儿就是几个字;也省一个第三方包(AGENTS.md C4 供应链)。认得常用那几样就够:
 * 标题、段落、粗体 / 斜体 / 删除线 / 行内代码、代码块、引用、列表(含嵌套)、表格、分隔线、链接(只认 http(s))。
 * 认不出的照字显示,不猜。
 */
import { Fragment, type ReactNode } from 'react';

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function indentOf(line: string): number {
  const lead = /^\s*/.exec(line)?.[0] ?? '';
  return lead.replace(/\t/g, '    ').length;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function safeHref(url: string): string | undefined {
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : undefined;
}

/** 行内:代码、粗体、斜体、删除线、链接、裸网址。 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w㐀-鿿])_([^_\s][^_]*?)_(?![\w㐀-鿿])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()（）「」，。]+)/g;
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${n++}`;
    if (match[2] !== undefined) out.push(<code key={k}>{match[2]}</code>);
    else if (match[3] !== undefined || match[4] !== undefined) out.push(<strong key={k}>{inline(match[3] ?? match[4] ?? '', k)}</strong>);
    else if (match[5] !== undefined) out.push(<del key={k}>{inline(match[5], k)}</del>);
    else if (match[6] !== undefined || match[7] !== undefined) out.push(<em key={k}>{inline(match[6] ?? match[7] ?? '', k)}</em>);
    else if (match[8] !== undefined) {
      const href = safeHref(match[9] ?? '');
      out.push(href === undefined
        ? <Fragment key={k}>{inline(match[8], k)}</Fragment>
        : <a key={k} href={href} target="_blank" rel="noopener noreferrer">{inline(match[8], k)}</a>);
    }
    else if (match[10] !== undefined) {
      const href = safeHref(match[10]);
      out.push(href === undefined ? match[10] : <a key={k} href={href} target="_blank" rel="noopener noreferrer">{match[10]}</a>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 一段里的几行:行与行之间换行。 */
function lines(text: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.forEach((one, index) => {
    if (index > 0) out.push(<br key={`${key}-br${index}`} />);
    out.push(<Fragment key={`${key}-l${index}`}>{inline(one.trim(), `${key}-${index}`)}</Fragment>);
  });
  return out;
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || LIST_ITEM.test(line) || QUOTE.test(line)
    || (line.includes('|') && next !== undefined && TABLE_RULE.test(next));
}

function blocks(source: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < source.length) {
    const line = source[i]!;
    const k = `${key}.${n++}`;
    if (line.trim() === '') { i += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      i += 1;
      while (i < source.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(source[i]!)) body.push(source[i++]!);
      i += 1;
      out.push(<pre key={k} className="ba-md__pre" {...(fence[2] === '' ? {} : { 'data-lang': fence[2] })}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = Math.min(6, heading[1]!.length);
      const Tag = `h${level}` as 'h1';
      out.push(<Tag key={k} className="ba-md__h">{inline(heading[2]!, k)}</Tag>);
      i += 1;
      continue;
    }
    if (HR.test(line) && !LIST_ITEM.test(line.replace(/^\s*[-*]\s*$/, ''))) {
      out.push(<hr key={k} />);
      i += 1;
      continue;
    }
    if (line.includes('|') && source[i + 1] !== undefined && TABLE_RULE.test(source[i + 1]!)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < source.length && source[i]!.includes('|') && source[i]!.trim() !== '') rows.push(splitRow(source[i++]!));
      out.push(
        <div key={k} className="ba-md__table">
          <table>
            <thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell, `${k}h${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, c) => <td key={c}>{inline(row[c] ?? '', `${k}r${r}c${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < source.length && QUOTE.test(source[i]!)) body.push(QUOTE.exec(source[i++]!)![1]!);
      out.push(<blockquote key={k} className="ba-md__quote">{blocks(body, k)}</blockquote>);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const base = indentOf(line);
      const ordered = /\d/.test(item[2]!);
      const items: { first: string, rest: string[] }[] = [];
      while (i < source.length) {
        const current = source[i]!;
        const match = LIST_ITEM.exec(current);
        if (match !== null && indentOf(current) <= base + 1 && /\d/.test(match[2]!) === ordered) {
          items.push({ first: match[3]!, rest: [] });
          i += 1;
          continue;
        }
        if (current.trim() === '') {
          // 空行之后还缩进着的,算这一项的;不然列表到这儿结束。
          const next = source[i + 1];
          if (next !== undefined && indentOf(next) > base && next.trim() !== '') { items[items.length - 1]?.rest.push(''); i += 1; continue; }
          break;
        }
        if (indentOf(current) > base && items.length > 0) {
          items[items.length - 1]!.rest.push(current.slice(Math.min(indentOf(current), base + 2)));
          i += 1;
          continue;
        }
        break;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={k} className="ba-md__list">
          {items.map((one, index) => (
            <li key={index}>
              {inline(one.first, `${k}i${index}`)}
              {one.rest.length > 0 && blocks(one.rest, `${k}i${index}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < source.length && source[i]!.trim() !== '' && (para.length === 0 || !isBlockStart(source[i]!, source[i + 1]))) para.push(source[i++]!);
    out.push(<p key={k} className="ba-md__p">{lines(para, k)}</p>);
  }
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  if (text.trim() === '') return null;
  return <div className={className === undefined ? 'ba-md' : `ba-md ${className}`}>{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 'md')}</div>;
}
