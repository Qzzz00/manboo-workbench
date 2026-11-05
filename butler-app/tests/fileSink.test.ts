import { describe, expect, it, vi } from 'vitest';
import {
  WBCH_SAVE_CHUNK_BYTES,
  WBCH_SAVE_FOLDER,
  WBCH_SHA_MISMATCH_TEXT,
  WBCH_SAVE_WHERE_TEXT,
  WBCH_SAVE_WHERE_WEB_TEXT,
  saveWbchFile,
  wbchSafeFileName,
} from '../src/channel/fileSink';

describe('文件名清洗(名字是房间里别人给的)', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\报告.pdf', '报告.pdf'],
    ['.hidden', 'hidden'],
    ['  留白.txt  ', '留白.txt'],
    ['', '未命名文件'],
    ['///', '未命名文件'],
  ])('%s → %s', (raw, want) => {
    expect(wbchSafeFileName(raw)).toBe(want);
  });

  it('太长的截短', () => {
    expect(wbchSafeFileName('a'.repeat(300))).toHaveLength(120);
  });
});

describe('落盘', () => {
  it('有原生桥 → 写进「文档 / 事务官」,名字清洗过', async () => {
    const writes: Record<string, unknown>[] = [];
    const result = await saveWbchFile(
      { name: '../电脑发来的.txt', bytes: new TextEncoder().encode('一二三') },
      { loadFilesystem: async () => ({ Filesystem: { writeFile: async (o) => { writes.push(o); return {}; } }, Directory: { Documents: 'DOCUMENTS' } }) },
    );
    expect(result).toEqual({ ok: true, saved: { name: '电脑发来的.txt', where: WBCH_SAVE_WHERE_TEXT, path: `${WBCH_SAVE_FOLDER}/电脑发来的.txt`, bytes: 9 } });
    expect(writes[0]).toMatchObject({ path: `${WBCH_SAVE_FOLDER}/电脑发来的.txt`, directory: 'DOCUMENTS', recursive: true });
    // 内容按 base64 送过去(原生桥只吃字符串),解回来必须和原字节一模一样
    const back = Uint8Array.from(atob(String(writes[0]?.data)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(back)).toBe('一二三');
  });

  it('没有原生桥(浏览器)→ 退回浏览器下载', async () => {
    const saved: string[] = [];
    const result = await saveWbchFile(
      { name: 'a.txt', bytes: new Uint8Array([1]) },
      { loadFilesystem: async () => { throw new Error('没有原生桥'); }, saveInBrowser: (name) => { saved.push(name); } },
    );
    expect(result).toEqual({ ok: true, saved: { name: 'a.txt', where: WBCH_SAVE_WHERE_WEB_TEXT, bytes: 1 } });
    expect(saved).toEqual(['a.txt']);
  });

  // 收到文件却没存下来,人却看见一句「收到了」是最糟的。
  it('两条路都不成 → 如实说没存下来', async () => {
    const result = await saveWbchFile(
      { name: 'a.txt', bytes: new Uint8Array([1]) },
      {
        loadFilesystem: async () => { throw new Error('写不进去'); },
        saveInBrowser: () => { throw new Error('浏览器也不让'); },
      },
    );
    expect(result).toEqual({ ok: false, error: '浏览器也不让' });
  });

  it('大文件的 base64 不爆栈', async () => {
    const writeFile = vi.fn(async () => ({}));
    const big = new Uint8Array(200_000).fill(65);
    const result = await saveWbchFile(
      { name: 'big.bin', bytes: big },
      { loadFilesystem: async () => ({ Filesystem: { writeFile }, Directory: { Documents: 'DOCUMENTS' } }) },
    );
    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});

describe('卡 J(2026-09-25):分块写、不覆盖、对 sha256', () => {
  function fakeFs(existing: string[] = []) {
    const calls: { op: string; path: unknown; data?: string }[] = [];
    const Filesystem = {
      writeFile: async (o: Record<string, unknown>) => { calls.push({ op: 'write', path: o.path, data: String(o.data) }); return {}; },
      appendFile: async (o: Record<string, unknown>) => { calls.push({ op: 'append', path: o.path, data: String(o.data) }); return {}; },
      stat: async (o: Record<string, unknown>) => { if (existing.includes(String(o.path))) return {}; throw new Error('没有'); },
      getUri: async (o: Record<string, unknown>) => ({ uri: `file:///storage/emulated/0/Documents/${String(o.path)}` }),
    };
    return { calls, loadFilesystem: async () => ({ Filesystem, Directory: { Documents: 'DOCUMENTS' } }) };
  }
  const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  it('大文件按 512KB 一块写:第一块 writeFile,其余 appendFile,拼回来一个字节不差', async () => {
    const fs = fakeFs();
    const big = new Uint8Array(WBCH_SAVE_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    const result = await saveWbchFile({ name: '录屏.mov', bytes: big }, { loadFilesystem: fs.loadFilesystem });
    expect(result.ok).toBe(true);
    expect(fs.calls.map((c) => c.op)).toEqual(['write', 'append', 'append']);
    const joined = fs.calls.flatMap((c) => [...decode(c.data ?? '')]);
    expect(joined).toEqual([...big]);
    expect(result.ok && result.saved).toMatchObject({ path: `${WBCH_SAVE_FOLDER}/录屏.mov`, uri: `file:///storage/emulated/0/Documents/${WBCH_SAVE_FOLDER}/录屏.mov`, bytes: big.length });
  });

  it('同名的不覆盖:README.md 在了就存成 README-2.md', async () => {
    const fs = fakeFs([`${WBCH_SAVE_FOLDER}/README.md`]);
    const result = await saveWbchFile({ name: 'README.md', bytes: new Uint8Array([1]) }, { loadFilesystem: fs.loadFilesystem });
    expect(result.ok && result.saved.name).toBe('README-2.md');
    expect(fs.calls[0]?.path).toBe(`${WBCH_SAVE_FOLDER}/README-2.md`);
  });

  it('sha256 对得上就存;对不上一个字节都不写,如实说', async () => {
    const bytes = new TextEncoder().encode('abc');
    const good = fakeFs();
    const ok = await saveWbchFile({ name: 'a.txt', bytes, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }, { loadFilesystem: good.loadFilesystem });
    expect(ok.ok).toBe(true);
    const bad = fakeFs();
    const wrong = await saveWbchFile({ name: 'a.txt', bytes, sha256: '00'.repeat(32) }, { loadFilesystem: bad.loadFilesystem });
    expect(wrong).toEqual({ ok: false, error: WBCH_SHA_MISMATCH_TEXT });
    expect(bad.calls).toEqual([]);
  });

  it('原生壳里写不进去:如实说没存下来,**不**退到「浏览器下载」', async () => {
    const g = globalThis as { Capacitor?: unknown };
    const before = g.Capacitor;
    g.Capacitor = { isNativePlatform: () => true };
    try {
      const saved: string[] = [];
      const result = await saveWbchFile(
        { name: 'a.txt', bytes: new Uint8Array([1]) },
        { loadFilesystem: async () => ({ Filesystem: { writeFile: async () => { throw new Error('磁盘满了'); } }, Directory: { Documents: 'DOCUMENTS' } }), saveInBrowser: (n) => { saved.push(n); } },
      );
      expect(result).toEqual({ ok: false, error: '手机上没存下来:磁盘满了' });
      expect(saved).toEqual([]);
    } finally {
      g.Capacitor = before;
    }
  });
});
