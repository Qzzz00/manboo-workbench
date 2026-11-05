/**
 * 「存到手机上」(2026-10-04,卡 `claude/phone-session-media`;统筹补的那张表最后一档:
 * 「其他(压缩包、设计稿等):名字 + 大小 + 点一下推到手机」)。
 *
 * ① 哪一种附件摆这颗键:编号是本机文件(`~p~`)或那家图库里的一个文件(`~k~`)才摆;
 *    写在对话记录里的 base64 图(`~b~`)不摆 —— 那一种没有对应的文件;
 * ② 点了之后:`view=keep` 让电脑开一张取件单,再走**现成的取文件那一下**;
 * ③ 在家直连取完说存在哪;出门经房间是「电脑在推」,如实说(不说「到了」);
 * ④ 电脑说不给(老电脑端 / 存不下来):原话摆出来。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createApiClient } from '../src/api/client';
import type { SessionAttachmentInfo, SessionAttachmentRef } from '../src/api/protocol';
import { AttachmentViewer, attachmentIsFile } from '../src/items/attachments/Attachments';
import { attachmentKeep } from '../src/items/attachments/attachmentsApi';

const FILE: SessionAttachmentRef = { ref: '120~p~L3RtcC_ntKAuemlw', name: '素材.zip', kind: 'archive', bytes: 2_000_000, from: 'ai' };
const BLOB: SessionAttachmentRef = { ref: `88~k~${'a'.repeat(64)}`, name: '截图 1.jpg', kind: 'image', from: 'ai' };
const INLINE: SessionAttachmentRef = { ref: '10~b~message.content.0', name: '图片 1.png', kind: 'image', bytes: 300, from: 'you' };

const info = (over: Partial<SessionAttachmentInfo>): SessionAttachmentInfo => ({ ref: 'x', name: 'x', kind: 'other', mime: 'application/octet-stream', bytes: 10, thumb: false, ...over });

function fakeClient(answers: Record<string, { status?: number; body: unknown }>) {
  const gets: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    gets.push(`${url.pathname}?${url.searchParams.toString()}`);
    const view = url.searchParams.get('view') ?? '';
    const got = answers[view] ?? { status: 404, body: { error: '没这条路' } };
    return new Response(JSON.stringify(got.body), { status: got.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: createApiClient({ pairing: { token: 't', host: 'h', port: 8791, deviceId: 'd' }, fetchImpl, onUnauthorized: () => {} }), gets };
}

beforeEach(() => {
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:fake-${++n}`, revokeObjectURL: () => {} }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('哪一种附件存得下来', () => {
  it('★本机文件与那家图库里的图存得下来;写在记录里的 base64 图存不下来', () => {
    expect(attachmentIsFile(FILE.ref)).toBe(true);
    expect(attachmentIsFile(BLOB.ref)).toBe(true);
    expect(attachmentIsFile(INLINE.ref)).toBe(false);
  });
});

describe('view=keep:开一张取件单', () => {
  it('★回的那几格认得出来(单号、名字、大小、在哪、类型)', async () => {
    const { client, gets } = fakeClient({ keep: { body: { offer: 'o1', name: '素材.zip', bytes: 2_000_000, where: '这条对话里', kind: 'other' } } });
    const got = await attachmentKeep(client, { agent: 'codex', sessionId: 's', ref: FILE.ref });
    expect(got.ok && got.value).toEqual({ offer: 'o1', name: '素材.zip', bytes: 2_000_000, where: '这条对话里', kind: 'other' });
    expect(gets[0]).toContain('view=keep');
  });

  it('老电脑端不认这个 view:原话回上去,不自己编一句', async () => {
    const { client } = fakeClient({ keep: { status: 400, body: { error: '要带上是哪一家、哪条对话、哪个附件' } } });
    const got = await attachmentKeep(client, { agent: 'codex', sessionId: 's', ref: FILE.ref });
    expect(got.ok).toBe(false);
    expect(!got.ok && got.error).toBe('要带上是哪一家、哪条对话、哪个附件');
  });

  it('电脑回的东西缺了单号:当没收到(网络上来的东西不猜)', async () => {
    const { client } = fakeClient({ keep: { body: { name: '素材.zip' } } });
    expect((await attachmentKeep(client, { agent: 'codex', sessionId: 's', ref: FILE.ref })).ok).toBe(false);
  });
});

describe('全屏那一格上的键', () => {
  const answers = {
    info: { body: info({ kind: 'archive', bytes: 2_000_000, note: '完整的到电脑上打开' }) },
  };

  it('★看不了全的那一类:摆「存到手机上」,点了之后把那一句原样写出来', async () => {
    const { client } = fakeClient(answers);
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={FILE} gallery={[]} online onMove={() => {}} onClose={() => {}} onKeep={async () => '收到「素材.zip」,存在手机「文档 / 事务官」里'} />);
    await act(async () => {});
    const keep = screen.getByRole('button', { name: '存到手机上' });
    fireEvent.click(keep);
    expect(screen.getByText('正在取「素材.zip」…')).toBeTruthy();
    await act(async () => {});
    expect(screen.getByText('收到「素材.zip」,存在手机「文档 / 事务官」里')).toBeTruthy();
  });

  it('写在记录里的图:不摆这颗键(存不下来)', async () => {
    const { client } = fakeClient({ info: { body: info({ kind: 'image', mime: 'image/png', thumb: false }) } });
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={INLINE} gallery={[]} online onMove={() => {}} onClose={() => {}} onKeep={async () => 'x'} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: '存到手机上' })).toBeNull();
  });

  it('电脑不在线 / 文件不在了:不摆这颗键', async () => {
    const { client } = fakeClient(answers);
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={FILE} gallery={[]} online={false} onMove={() => {}} onClose={() => {}} onKeep={async () => 'x'} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: '存到手机上' })).toBeNull();
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={{ ...FILE, missing: true }} gallery={[]} online onMove={() => {}} onClose={() => {}} onKeep={async () => 'x'} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: '存到手机上' })).toBeNull();
  });

  /**
   * 统筹 10-04:「视频别整份几百 MB 先下载」。整份是 512KB 一块拼的,一段大视频在外面就是几百次往返 ——
   * 所以先摆一张卡(第一帧 + 大小 + 一句),她点「就在这里放」那一下才去取。
   */
  it('★大视频先不自动取:卡上写清多大、摆「就在这里放」;点了才一块一块取', async () => {
    const big: SessionAttachmentRef = { ref: '200~p~L3RtcC9hLm1wNA', name: '样片.mp4', kind: 'video', bytes: 40 * 1024 * 1024, from: 'ai' };
    const { client, gets } = fakeClient({
      info: { body: info({ kind: 'video', mime: 'video/mp4', bytes: 40 * 1024 * 1024, thumb: true, full: { mime: 'video/mp4', bytes: 40 * 1024 * 1024, parts: 80 } }) },
      thumb: { body: { ref: big.ref, view: 'thumb', part: 0, parts: 1, mime: 'image/jpeg', data: 'AAAA' } },
      full: { body: { ref: big.ref, view: 'full', part: 0, parts: 80, mime: 'video/mp4', data: 'AAAA' } },
    });
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={big} gallery={[]} online onMove={() => {}} onClose={() => {}} onKeep={async () => 'x'} />);
    await act(async () => {});
    expect(screen.getByText(/40\.0 MB,先不自动取/)).toBeTruthy();
    expect(gets.some((one) => one.includes('view=full'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '就在这里放' }));
    await act(async () => {});
    expect(gets.some((one) => one.includes('view=full'))).toBe(true);
  });

  it('小一点的音视频照旧直接放(这条规矩只管大块头)', async () => {
    const small: SessionAttachmentRef = { ref: '201~p~L3RtcC9iLm1wNA', name: '短片.mp4', kind: 'video', bytes: 1024, from: 'ai' };
    const { client, gets } = fakeClient({
      info: { body: info({ kind: 'video', mime: 'video/mp4', bytes: 1024, thumb: false, full: { mime: 'video/mp4', bytes: 1024, parts: 1 } }) },
      full: { body: { ref: small.ref, view: 'full', part: 0, parts: 1, mime: 'video/mp4', data: 'AAAA' } },
    });
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={small} gallery={[]} online onMove={() => {}} onClose={() => {}} />);
    await act(async () => {});
    expect(gets.some((one) => one.includes('view=full'))).toBe(true);
    expect(screen.queryByRole('button', { name: '就在这里放' })).toBeNull();
  });

  it('取不回来:那一句原样摆出来(不说成「到了」)', async () => {
    const { client } = fakeClient(answers);
    render(<AttachmentViewer client={client} agent="codex" sessionId="s" item={FILE} gallery={[]} online onMove={() => {}} onClose={() => {}} onKeep={async () => '「素材.zip」没取回来:这个文件不在授权过的目录里了,不传'} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '存到手机上' }));
    await act(async () => {});
    expect(screen.getByText('「素材.zip」没取回来:这个文件不在授权过的目录里了,不传')).toBeTruthy();
  });
});
