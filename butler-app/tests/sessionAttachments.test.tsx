/**
 * 对话里的附件(2026-10-01,手机读对话卡 C;维护者:「图片、视频、md 文件……更别说点击、放大缩小」;
 * 统筹:「任何文件至少有一张卡,能读的就显示内容」「安卓上没有快速预览,转换都在 Mac 上做」「电脑不在线时写一句」)。
 *
 * ① 卡:名字、类型、大小、缩略图(看得见才要);不在了的、电脑不在线的写一句,不能点;
 * ② 点开:图片全屏、双指缩放、左右滑换同一条对话里的下一张;视频播不了如实说;
 * ③ md 按格式、代码等宽、csv 成表、网页放进不跑脚本不联网的框、PDF 一页一页翻、别的给缩略图 + 一句;
 * ④ 整份是一块一块要来拼的(每块装得进中转一条回包)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createApiClient } from '../src/api/client';
import type { SessionAttachmentChunk, SessionAttachmentInfo, SessionAttachmentRef } from '../src/api/protocol';
import { AttachmentStrip, AttachmentViewer, sandboxedHtml } from '../src/items/attachments/Attachments';
import { ATTACHMENT_MISSING, ATTACHMENT_OFFLINE } from '../src/items/attachments/attachmentsApi';

const A: SessionAttachmentRef = { ref: '10~b~message.content.0', name: '图片 1.png', kind: 'image', bytes: 340_000, from: 'you' };
const B: SessionAttachmentRef = { ref: '99~b~message.content.0.content.0', name: '图片 2.png', kind: 'image', bytes: 20_000, from: 'ai' };

const info = (over: Partial<SessionAttachmentInfo>): SessionAttachmentInfo => ({ ref: 'x', name: 'x', kind: 'other', mime: 'application/octet-stream', bytes: 10, thumb: false, ...over });

function fakeClient(answers: Record<string, (q: URLSearchParams) => { status?: number; body: unknown }>) {
  const gets: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    gets.push(`${url.pathname}?${url.searchParams.toString()}`);
    const ref = url.searchParams.get('ref') ?? '';
    const view = url.searchParams.get('view') ?? '';
    const answer = answers[`${ref}|${view}`] ?? answers[`*|${view}`];
    const got = answer === undefined ? { status: 404, body: { error: '没这条路' } } : answer(url.searchParams);
    return new Response(JSON.stringify(got.body), { status: got.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: createApiClient({ pairing: { token: 't', host: 'h', port: 8791, deviceId: 'd' }, fetchImpl, onUnauthorized: () => {} }), gets };
}

const chunk = (over: Partial<SessionAttachmentChunk>): SessionAttachmentChunk => ({ ref: 'x', view: 'full', part: 0, parts: 1, ...over });

beforeEach(() => {
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:fake-${++n}`, revokeObjectURL: () => {} }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('附件卡', () => {
  it('★名字、类型、大小、谁发的;缩略图向电脑要;点开交出去', async () => {
    const { client, gets } = fakeClient({ '*|thumb': () => ({ body: chunk({ view: 'thumb', mime: 'image/jpeg', data: 'AAAA' }) }) });
    const opened: string[] = [];
    render(<AttachmentStrip client={client} agent="claude" sessionId="s" refs={[A]} online onOpen={(one) => opened.push(one.ref)} />);
    const card = screen.getByRole('button', { name: /图片 1\.png/ });
    expect(card.textContent).toContain('图片 · 332 KB · 你发的');
    await act(async () => {});
    expect(card.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(gets[0]).toContain('view=thumb');
    fireEvent.click(card);
    expect(opened).toEqual([A.ref]);
  });

  it('★电脑不在线:只有名字和类型,写「电脑不在线,打不开」,不去要、不能点;不在了的同样', () => {
    const { client, gets } = fakeClient({});
    render(<AttachmentStrip client={client} agent="claude" sessionId="s" refs={[A, { ...B, missing: true }]} online={false} onOpen={() => {}} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(ATTACHMENT_OFFLINE)).toBeTruthy();
    expect(gets).toEqual([]);
    render(<AttachmentStrip client={client} agent="claude" sessionId="s" refs={[{ ...B, missing: true }]} online onOpen={() => {}} />);
    // 第一份里那张不在了的也写的是「不在了」(不在了比不在线更确定)
    expect(screen.getAllByText(ATTACHMENT_MISSING)).toHaveLength(2);
  });
});

function viewer(item: SessionAttachmentRef, answers: Parameters<typeof fakeClient>[0], gallery: SessionAttachmentRef[] = [item]) {
  const { client, gets } = fakeClient(answers);
  const moves: string[] = [];
  const view = render(<AttachmentViewer client={client} agent="claude" sessionId="s" item={item} gallery={gallery} online onMove={(one) => moves.push(one.name)} onClose={() => {}} />);
  return { gets, moves, view };
}

describe('点开全屏看', () => {
  it('★图片:整份一块一块要来拼;双指缩放;没放大时左右滑换下一张', async () => {
    const { gets, moves, view } = viewer(A, {
      [`${A.ref}|info`]: () => ({ body: info({ kind: 'image', mime: 'image/png', thumb: true, full: { mime: 'image/png', bytes: 600_000, parts: 2 } }) }),
      [`${A.ref}|thumb`]: () => ({ body: chunk({ view: 'thumb', mime: 'image/png', data: 'AAAA' }) }),
      [`${A.ref}|full`]: (q) => ({ body: chunk({ part: Number(q.get('part')), parts: 2, mime: 'image/png', data: 'AAAA' }) }),
    }, [A, B]);
    await act(async () => {});
    const dialog = screen.getByRole('dialog', { name: '看附件' });
    expect(within(dialog).getByText('1 / 2')).toBeTruthy();
    expect(gets.filter((one) => one.includes('view=full')).map((one) => new URLSearchParams(one.split('?')[1]).get('part'))).toEqual(['0', '1']);
    const img = dialog.querySelector('.ba-zoom img');
    expect(img?.getAttribute('src')).toMatch(/^blob:fake-/);
    const zoom = view.container.ownerDocument.querySelector('.ba-zoom') as HTMLElement;
    // 两指张开
    fireEvent.pointerDown(zoom, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(zoom, { pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(zoom, { pointerId: 2, clientX: 300, clientY: 100 });
    expect(Number(zoom.getAttribute('data-scale'))).toBeGreaterThan(1.5);
    fireEvent.pointerUp(zoom, { pointerId: 2, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(zoom, { pointerId: 1, clientX: 100, clientY: 100 });
    // 放大时横滑是拖图,不换张
    fireEvent.pointerDown(zoom, { pointerId: 3, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(zoom, { pointerId: 3, clientX: 100, clientY: 100 });
    expect(moves).toEqual([]);
    // 双击还原,再横滑 → 下一张
    for (let i = 0; i < 2; i++) { fireEvent.pointerDown(zoom, { pointerId: 4 + i, clientX: 10, clientY: 10 }); fireEvent.pointerUp(zoom, { pointerId: 4 + i, clientX: 10, clientY: 10 }); }
    expect(zoom.getAttribute('data-scale')).toBe('1.00');
    fireEvent.pointerDown(zoom, { pointerId: 9, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(zoom, { pointerId: 9, clientX: 100, clientY: 110 });
    expect(moves).toEqual(['图片 2.png']);
  });

  it('视频:能播就播;播不了如实说「到电脑上看」,不黑屏', async () => {
    const mov: SessionAttachmentRef = { ref: '5~p~eA', name: 'a.mov', kind: 'video', from: 'ai' };
    viewer(mov, {
      [`${mov.ref}|info`]: () => ({ body: info({ kind: 'video', mime: 'video/quicktime', full: { mime: 'video/quicktime', bytes: 10, parts: 1 } }) }),
      [`${mov.ref}|full`]: () => ({ body: chunk({ mime: 'video/quicktime', data: 'AAAA' }) }),
    });
    await act(async () => {});
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toMatch(/^blob:/);
    fireEvent.error(video);
    expect(screen.getByText('这段视频手机上放不了,到电脑上看')).toBeTruthy();
  });

  it('★md 按格式;代码等宽;csv 成表;网页进不跑脚本、不联网的框', async () => {
    const md: SessionAttachmentRef = { ref: '1~p~bWQ', name: '交接.md', kind: 'markdown', from: 'ai' };
    viewer(md, {
      [`${md.ref}|info`]: () => ({ body: info({ kind: 'markdown', text: { format: 'markdown', parts: 1 } }) }),
      [`${md.ref}|text`]: () => ({ body: chunk({ view: 'text', text: '# 交接\n\n**已拍板**' }) }),
    });
    await act(async () => {});
    expect(document.querySelector('.ba-viewer strong')?.textContent).toBe('已拍板');

    const csv: SessionAttachmentRef = { ref: '2~p~Y3N2', name: 'a.csv', kind: 'table', from: 'ai' };
    viewer(csv, {
      [`${csv.ref}|info`]: () => ({ body: info({ kind: 'table', text: { format: 'table', parts: 1 } }) }),
      [`${csv.ref}|text`]: () => ({ body: chunk({ view: 'text', rows: [['名', '值'], ['甲', '1']] }) }),
    });
    await act(async () => {});
    expect([...document.querySelectorAll('.ba-viewer__table th')].map((th) => th.textContent)).toEqual(['名', '值']);

    const code: SessionAttachmentRef = { ref: '3~p~dHM', name: 'a.ts', kind: 'code', from: 'ai' };
    viewer(code, {
      [`${code.ref}|info`]: () => ({ body: info({ kind: 'code', text: { format: 'code', parts: 1, lang: 'ts' } }) }),
      [`${code.ref}|text`]: () => ({ body: chunk({ view: 'text', text: 'const a = 1' }) }),
    });
    await act(async () => {});
    expect(document.querySelector('.ba-viewer__code')?.getAttribute('data-lang')).toBe('ts');

    const page: SessionAttachmentRef = { ref: '4~p~aHRtbA', name: 'p.html', kind: 'html', from: 'ai' };
    viewer(page, {
      [`${page.ref}|info`]: () => ({ body: info({ kind: 'html', text: { format: 'html', parts: 1 } }) }),
      [`${page.ref}|text`]: () => ({ body: chunk({ view: 'text', text: '<h1>页</h1><script>alert(1)</script>' }) }),
    });
    await act(async () => {});
    const frame = document.querySelector('iframe.ba-viewer__html') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(sandboxedHtml('<b>x</b>')).toMatch(/Content-Security-Policy/);
  });

  it('★PDF:一页一张图,左右翻,能缩放', async () => {
    const pdf: SessionAttachmentRef = { ref: '6~p~cGRm', name: '说明.pdf', kind: 'pdf', from: 'ai' };
    const { gets } = viewer(pdf, {
      [`${pdf.ref}|info`]: () => ({ body: info({ kind: 'pdf', pages: 3, thumb: true }) }),
      [`${pdf.ref}|thumb`]: () => ({ body: chunk({ view: 'thumb', data: 'AAAA' }) }),
      [`${pdf.ref}|page`]: (q) => ({ body: chunk({ view: 'page', part: Number(q.get('page')), parts: 3, mime: 'image/jpeg', data: 'AAAA' }) }),
    });
    await act(async () => {});
    expect(screen.getByText('1 / 3')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下一页' })); });
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(gets.filter((one) => one.includes('view=page')).map((one) => new URLSearchParams(one.split('?')[1]).get('page'))).toEqual(['0', '1']);
    expect(document.querySelector('.ba-viewer .ba-zoom img')).not.toBeNull();
  });

  it('幻灯片这类:缩略图 + 一句「完整的到电脑上打开」', async () => {
    const key: SessionAttachmentRef = { ref: '7~p~a2V5', name: '路演.key', kind: 'slides', from: 'ai' };
    viewer(key, {
      [`${key.ref}|info`]: () => ({ body: info({ kind: 'slides', thumb: true, bytes: 2_000_000, note: '完整的到电脑上打开' }) }),
      [`${key.ref}|thumb`]: () => ({ body: chunk({ view: 'thumb', mime: 'image/png', data: 'AAAA' }) }),
    });
    await act(async () => {});
    expect(document.querySelector('.ba-viewer__card img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(screen.getByText('完整的到电脑上打开')).toBeTruthy();
    expect(screen.getByText('幻灯片 · 1.9 MB')).toBeTruthy();
  });

  it('电脑说不给(不在这条对话里 / 不在了):原话摆出来', async () => {
    viewer(A, { [`${A.ref}|info`]: () => ({ status: 410, body: { error: '电脑上这个文件已经不在了' } }) });
    await act(async () => {});
    expect(screen.getByText('电脑上这个文件已经不在了')).toBeTruthy();
  });
});
