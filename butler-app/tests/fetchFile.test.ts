/**
 * 手机从电脑取文件 · 手机这一侧(2026-09-25,卡 J `feat/phone-fetch-file`)。
 *
 *   ① 协议:`file_pull` 出去、`file_pull` 答复与 `file_status` 回来;
 *   ② 房间那一层:一块一块读、边读边报进度、流上的 sha256 带给存盘那一层;断在半路说断在百分之几;
 *   ③ 取:在家直连下载(边下边报),服务端明说不给就不换路;直连断了 / 本来在外面 → 经房间让电脑推;
 *   ④ 收到的文件:现读「文档 / 事务官」、新的在前;打开 / 分享交给原生,原生没有就如实说在哪看。
 */
import { describe, expect, it, vi } from 'vitest';
import { parseWbchInbound } from '../src/channel/channelProtocol';
import { createWbchRpc } from '../src/channel/rpc';
import { createWbchRoomLink, type WbchFileIn, type WbchFileProgress, type WbchLivekitSdk } from '../src/channel/roomLink';
import { WBCH_FILE_TOPIC, WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import type { ApiClient, ApiResult, ApiDownload } from '../src/api/client';
import { PULL_NO_ROOM_TEXT, fetchPendingFileAsks, kindOfName, parseFileAsk, progressText, pullFileOffer, reportFileReceived, sizeText, type FileAskHit } from '../src/files/fileFetch';
import { OPEN_UNAVAILABLE_TEXT, listReceivedFiles, openReceivedFile, receivedTimeText, shareReceivedFile } from '../src/files/receivedFiles';
import { createFakeLink, fakeCredential } from './wbchFakes';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('① 协议', () => {
  it('file_pull 的答复与 file_status 都读得出来;缺骨头就当没收到', () => {
    expect(parseWbchInbound(JSON.stringify({ id: 'a', type: 'file_pull', ok: true, name: 'README.md', bytes: 12 })))
      .toEqual({ id: 'a', type: 'file_pull', ok: true, name: 'README.md', bytes: 12 });
    expect(parseWbchInbound(JSON.stringify({ type: 'file_status', name: '录屏.mov', ok: false, error: '手机不在房里' })))
      .toEqual({ type: 'file_status', name: '录屏.mov', ok: false, error: '手机不在房里' });
    expect(parseWbchInbound(JSON.stringify({ type: 'file_status', ok: false }))).toBeNull();
    expect(parseWbchInbound(JSON.stringify({ type: 'file_pull', ok: true }))).toBeNull();
  });

  it('rpc.filePull 照协议发、等工人那一条答复;工人说没推就把原话带回来', async () => {
    const link = createFakeLink();
    let n = 0;
    const rpc = createWbchRpc({ link, newId: () => `f${++n}` });
    const first = rpc.filePull('offer-1');
    expect(JSON.parse(link.sent[0]?.text ?? '{}')).toEqual({ id: 'f1', type: 'file_pull', offer: 'offer-1' });
    link.deliver({ id: 'f1', type: 'file_pull', ok: true, name: 'README.md', bytes: 12 });
    await expect(first).resolves.toEqual({ ok: true, name: 'README.md', bytes: 12 });

    const second = rpc.filePull('offer-2');
    link.deliver({ id: 'f2', type: 'file_pull', ok: false, error: '这张取件单不在了' });
    await expect(second).resolves.toEqual({ ok: false, error: '这张取件单不在了' });
  });

  it('file_status 是推送:交给 onFileStatus,不配对答复', () => {
    const link = createFakeLink();
    const got: unknown[] = [];
    createWbchRpc({ link, onFileStatus: (s) => got.push(s) });
    link.deliver({ type: 'file_status', name: 'a.pdf', ok: false, error: '太大了' });
    expect(got).toEqual([{ type: 'file_status', name: 'a.pdf', ok: false, error: '太大了' }]);
  });
});

describe('② 房间那一层:边读边报', () => {
  function sdkWithReader() {
    const rooms: any[] = [];
    class FakeRoom {
      byteHandlers = new Map<string, (reader: any, info: any) => void>();
      remoteParticipants = new Map<string, unknown>();
      localParticipant = { identity: 'wb-phone-dev1', sendText: async () => {}, sendFile: async () => {} };
      constructor() { rooms.push(this); }
      on() { return this; }
      registerByteStreamHandler(topic: string, handler: (reader: any, info: any) => void) { this.byteHandlers.set(topic, handler); }
      registerTextStreamHandler() {}
      async connect() {}
      async disconnect() {}
    }
    const sdk: WbchLivekitSdk = { Room: FakeRoom as never, RoomEvent: {} };
    return { sdk, rooms };
  }

  function readerOf(chunks: Uint8Array[], info: Record<string, unknown>, failAfter?: number) {
    return {
      info,
      async *[Symbol.asyncIterator]() {
        let i = 0;
        for (const chunk of chunks) {
          if (failAfter !== undefined && i === failAfter) throw new Error('对面掉线了');
          i += 1;
          yield chunk;
        }
      },
    };
  }

  it('每 256KB 报一次进度,收完带着 sha256 交给 onFile', async () => {
    const { sdk, rooms } = sdkWithReader();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.acquire('pull', fakeCredential());
    const progress: WbchFileProgress[] = [];
    const files: WbchFileIn[] = [];
    link.listen({ onFileProgress: (p) => progress.push(p), onFile: (f) => files.push(f) });
    const chunk = new Uint8Array(300 * 1024).fill(7);
    rooms[0].byteHandlers.get(WBCH_FILE_TOPIC)(
      readerOf([chunk, chunk], { id: 's1', name: '录屏.mov', mimeType: 'video/quicktime', size: chunk.length * 2, attributes: { sha256: 'abc', bytes: String(chunk.length * 2) } }),
      { identity: WBCH_WORKER_IDENTITY },
    );
    await vi.waitFor(() => expect(files).toHaveLength(1));
    expect(progress.map((p) => [p.received, p.total, p.done === true])).toEqual([
      [0, 614400, false],
      [307200, 614400, false],
      [614400, 614400, false],
      [614400, 614400, true],
    ]);
    expect(files[0]).toMatchObject({ name: '录屏.mov', from: WBCH_WORKER_IDENTITY, attributes: { sha256: 'abc', bytes: '614400' } });
    expect(files[0]?.bytes.length).toBe(614400);
  });

  it('断在半路:报一句「传到一半断了(收到 X%)」,不交半个文件', async () => {
    const { sdk, rooms } = sdkWithReader();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.acquire('pull', fakeCredential());
    const progress: WbchFileProgress[] = [];
    const files: WbchFileIn[] = [];
    link.listen({ onFileProgress: (p) => progress.push(p), onFile: (f) => files.push(f) });
    const chunk = new Uint8Array(100);
    rooms[0].byteHandlers.get(WBCH_FILE_TOPIC)(readerOf([chunk, chunk, chunk, chunk], { id: 's2', name: 'a.pdf', size: 400 }, 1), { identity: WBCH_WORKER_IDENTITY });
    await vi.waitFor(() => expect(progress.some((p) => p.failed !== undefined)).toBe(true));
    expect(progress[progress.length - 1]?.failed).toBe('传到一半断了(收到 25%):对面掉线了');
    expect(files).toEqual([]);
  });
});

describe('③ 取', () => {
  const hit: FileAskHit = { offer: 'o-1', name: 'README.md', where: 'desktop-workbench', bytes: 3, kind: 'text' };
  const memorySink = () => {
    const writes: Record<string, unknown>[] = [];
    return {
      writes,
      sink: { loadFilesystem: async () => ({ Filesystem: { writeFile: async (o: Record<string, unknown>) => { writes.push(o); return {}; } }, Directory: { Documents: 'DOCUMENTS' } }) },
    };
  };
  function directClient(result: ApiResult<ApiDownload>, seen: string[] = []): ApiClient {
    return {
      baseUrl: 'http://10.0.0.2:8791',
      json: async () => ({ ok: false, status: 0, kind: 'network', error: 'x' }),
      blob: async () => ({ ok: false, status: 0, kind: 'network', error: 'x' }),
      download: async (path, options) => { seen.push(path); options?.onProgress?.(3, 3); return result; },
    };
  }

  it('在家:直接下载、边下边报、存进「文档 / 事务官」,不去打扰房间', async () => {
    const seen: string[] = [];
    const room = vi.fn();
    const progress: number[] = [];
    const { writes, sink } = memorySink();
    const outcome = await pullFileOffer(hit, {
      mode: () => 'direct',
      direct: directClient({ ok: true, status: 200, data: { bytes: new TextEncoder().encode('abc'), total: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' } }, seen),
      pullViaRoom: room,
      onProgress: (n) => progress.push(n),
      sink,
    });
    expect(outcome).toMatchObject({ via: 'direct', ok: true, saved: { name: 'README.md', path: '事务官/README.md' } });
    expect(seen).toEqual(['/files/offer/o-1']);
    expect(progress).toEqual([3]);
    expect(room).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it('直连下来的和电脑上那份对不上:不存,如实说', async () => {
    const outcome = await pullFileOffer(hit, {
      mode: () => 'direct',
      direct: directClient({ ok: true, status: 200, data: { bytes: new TextEncoder().encode('abc'), sha256: '00'.repeat(32) } }),
      sink: memorySink().sink,
    });
    expect(outcome).toMatchObject({ via: 'direct', ok: false, error: expect.stringContaining('对不上') });
  });

  it('服务端明说不给(文件没了 410):不换路重试,原话带回来', async () => {
    const room = vi.fn();
    const outcome = await pullFileOffer(hit, {
      mode: () => 'direct',
      direct: directClient({ ok: false, status: 410, kind: 'http', error: '电脑上这个文件已经不在了' }),
      pullViaRoom: room,
    });
    expect(outcome).toEqual({ via: 'direct', ok: false, error: '电脑上这个文件已经不在了' });
    expect(room).not.toHaveBeenCalled();
  });

  it('直连半路断了(出门了):退到房间让电脑推', async () => {
    const room = vi.fn(async () => ({ ok: true as const, name: 'README.md', bytes: 3 }));
    const outcome = await pullFileOffer(hit, {
      mode: () => 'direct',
      direct: directClient({ ok: false, status: 0, kind: 'network', error: '连不上' }),
      pullViaRoom: room,
    });
    expect(outcome).toEqual({ via: 'room', ok: true });
    expect(room).toHaveBeenCalledWith('o-1');
  });

  it('本来就在外面:直接经房间;这一版通道层没有这条路就如实说', async () => {
    const room = vi.fn(async () => ({ ok: false as const, error: '这台手机的房间里没有电脑' }));
    expect(await pullFileOffer(hit, { mode: () => 'remote', direct: directClient({ ok: false, status: 0, kind: 'network', error: '' }), pullViaRoom: room }))
      .toEqual({ via: 'room', ok: false, error: '这台手机的房间里没有电脑' });
    expect(await pullFileOffer(hit, { mode: () => 'remote', direct: directClient({ ok: false, status: 0, kind: 'network', error: '' }) }))
      .toEqual({ via: 'room', ok: false, error: PULL_NO_ROOM_TEXT });
  });

  it('卡片:读得出来;坏的候选丢掉;大类认不出按名字认', () => {
    const ask = parseFileAsk({
      id: 'a1', request: '把 README 发我', query: 'readme', device: '书房 Mac', total: 3,
      hits: [{ offer: 'o1', name: 'README.md', where: 'x', bytes: 3, kind: 'text' }, { name: '没单号' }, { offer: 'o2', name: '截图.png', bytes: 5, kind: '???' }],
    });
    expect(ask?.hits.map((h) => [h.name, h.kind])).toEqual([['README.md', 'text'], ['截图.png', 'image']]);
    expect(parseFileAsk({ hits: [] })).toBeNull();
  });

  it('进度那一句', () => {
    expect(progressText({ name: '录屏.mov', received: 14.8 * 1024 * 1024, total: 40 * 1024 * 1024 })).toBe('正在收「录屏.mov」37% · 14.8 MB / 40.0 MB');
    expect(progressText({ name: 'a', received: 2048 })).toBe('正在收「a」· 已收 2.0 KB');
    expect(sizeText(900)).toBe('900 字节');
    expect(kindOfName('产品说明.PDF')).toBe('pdf');
  });
});

describe('④ 收到的文件', () => {
  it('现读「文档 / 事务官」,新的在前,文件夹与隐藏文件不列', async () => {
    const listed = await listReceivedFiles({
      loadFilesystem: async () => ({
        Filesystem: {
          readdir: async (o: Record<string, unknown>) => {
            expect(o).toEqual({ path: '事务官', directory: 'DOCUMENTS' });
            return {
              files: [
                { name: 'README.md', type: 'file', size: 3, mtime: 100, uri: 'file:///d/事务官/README.md' },
                { name: '截图.png', type: 'file', size: 5, mtime: 300 },
                { name: '子目录', type: 'directory' },
                { name: '.DS_Store', type: 'file', size: 1, mtime: 999 },
              ],
            };
          },
        },
        Directory: { Documents: 'DOCUMENTS' },
      }),
    });
    expect(listed.files.map((f) => [f.name, f.kind])).toEqual([['截图.png', 'image'], ['README.md', 'text']]);
    expect(listed.files[1]?.uri).toBe('file:///d/事务官/README.md');
  });

  it('读不到就是空的,带一句话(不抛)', async () => {
    const listed = await listReceivedFiles({ loadFilesystem: async () => { throw new Error('没有原生桥'); } });
    expect(listed.files).toEqual([]);
    expect(listed.note).toContain('还没有收到过文件');
  });

  it('打开 / 分享:交给原生,带 file:// 地址与按名字认的 MIME', async () => {
    const calls: unknown[] = [];
    const native = { open: async (o: unknown) => { calls.push(['open', o]); }, share: async (o: unknown) => { calls.push(['share', o]); } };
    const file = { name: '产品说明.pdf', path: '事务官/产品说明.pdf', uri: 'file:///x/产品说明.pdf', bytes: 1, kind: 'pdf' as const };
    expect(await openReceivedFile(file, { native })).toEqual({ ok: true });
    expect(await shareReceivedFile(file, { native })).toEqual({ ok: true });
    expect(calls).toEqual([
      ['open', { path: 'file:///x/产品说明.pdf', mimeType: 'application/pdf' }],
      ['share', { path: 'file:///x/产品说明.pdf', mimeType: 'application/pdf', name: '产品说明.pdf' }],
    ]);
  });

  it('原生没有这件插件(浏览器里):如实说到哪儿去看;原生拒了就原话', async () => {
    const file = { name: 'a.txt', path: '事务官/a.txt', bytes: 1, kind: 'text' as const };
    const missing = { open: async () => { throw new Error('"FileOpener" plugin is not implemented on web'); }, share: async () => { throw new Error('x'); } };
    expect(await openReceivedFile(file, { native: missing })).toEqual({ ok: false, error: OPEN_UNAVAILABLE_TEXT });
    const refused = { open: async () => { throw new Error('手机上没有能打开这种文件的应用'); }, share: async () => {} };
    expect(await openReceivedFile(file, { native: refused })).toEqual({ ok: false, error: '手机上没有能打开这种文件的应用' });
  });

  it('时间:今天的只写时刻', () => {
    const now = new Date(2026, 8, 25, 15, 0).getTime();
    expect(receivedTimeText(new Date(2026, 8, 25, 14, 3).getTime(), now)).toBe('14:03');
    expect(receivedTimeText(new Date(2026, 8, 24, 9, 5).getTime(), now)).toBe('09-24 09:05');
    expect(receivedTimeText(undefined, now)).toBe('');
  });
});

/**
 * ——— ⑤ 电脑主动推过来的那张卡 + 收到了报一句(2026-10-04,卡 `claude/phone-file-send-loop`) ———
 *
 * 为什么要这两件:10-04 早上她在手机上说「官网逐字稿,这份文件发到我这个手机上。」,
 * 事务官找到文件之后**没有任何办法把卡摆到她面前**,只能回「你在手机上再打一句」——
 * 而那件事已经被记成完成。现在卡由电脑推,收到了还要报一句回执。
 */
describe('⑤ 推过来的卡与回执', () => {
  function pendingClient(payload: unknown, seen: { path: string; body?: unknown }[] = []): ApiClient {
    return {
      baseUrl: 'http://10.0.0.2:8791',
      json: (async (path: string, init?: { body?: unknown }) => {
        seen.push({ path, ...(init?.body === undefined ? {} : { body: init.body }) });
        return { ok: true, status: 200, data: payload };
      }) as unknown as ApiClient['json'],
      blob: async () => ({ ok: false, status: 0, kind: 'network', error: 'x' }),
    };
  }

  it('问一次就把卡读出来(只认有候选的那几张)', async () => {
    const asks = await fetchPendingFileAsks(pendingClient({
      file_asks: [
        { id: 'a1', request: '官网逐字稿,这份文件发到我这个手机上。', query: '官网逐字稿', device: '书房 Mac', total: 1, hits: [{ offer: 'o1', name: '官网逐字稿.md', where: 'desktop-workbench / docs', bytes: 12, kind: 'text' }] },
        // 一个候选都没有的那张不摆给她(她点不了,只会挡着屏)。
        { id: 'a2', request: 'x', query: 'y', device: '书房 Mac', total: 0, hits: [] },
      ],
    }));
    expect(asks).toHaveLength(1);
    expect(asks[0]?.hits[0]?.name).toBe('官网逐字稿.md');
  });

  it('问不到就当这一拍没有(不编一张)', async () => {
    const client: ApiClient = {
      baseUrl: 'http://10.0.0.2:8791',
      json: async () => ({ ok: false, status: 0, kind: 'network', error: '连不上' }),
      blob: async () => ({ ok: false, status: 0, kind: 'network', error: 'x' }),
    };
    expect(await fetchPendingFileAsks(client)).toEqual([]);
  });

  it('收到了报一句:单号、成没成、多少字节都带上', async () => {
    const seen: { path: string; body?: unknown }[] = [];
    await reportFileReceived(pendingClient({ ok: true }, seen), { offer: 'o1', ok: true, bytes: 12 });
    expect(seen).toEqual([{ path: '/files/received', body: { offer: 'o1', ok: true, bytes: 12 } }]);
  });

  it('报不上去不抛(文件确实已经在手机上了)', async () => {
    const client: ApiClient = {
      baseUrl: 'http://10.0.0.2:8791',
      json: async () => { throw new Error('断了'); },
      blob: async () => ({ ok: false, status: 0, kind: 'network', error: 'x' }),
    };
    await expect(reportFileReceived(client, { offer: 'o1', ok: true })).resolves.toBeUndefined();
  });
});
