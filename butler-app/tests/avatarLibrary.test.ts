/**
 * 手机上的形象库(2026-10-01 起;2026-10-21 起只有一种来源:电脑上 butler-server 上传并发布过的形象)。
 * 仓库与 App 里一个模型都不带 —— 没配对、电脑上没上传过时,只有粒子球。
 */
import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../src/api/tokenStore';
import {
  CHOICE_KEY, INDEX_KEY, PARTICLES, createAvatarLibrary, idlePlanFromModel, pickModelEntry,
  type AvatarFs, type AvatarSource, type ServerAvatar,
} from '../src/avatars/library';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

const enc = (s: string) => new TextEncoder().encode(s);
const MODEL = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'm.moc3',
    Motions: {
      Idle: [{ File: 'motions/idle_01.motion3.json' }, { File: 'motions/idle_02.motion3.json' }],
      TapBody: [{ File: 'motions/tap.motion3.json' }],
      Wave: [{ File: 'motions/wave.motion3.json' }],
    },
  },
});
const FILES = [
  { path: 'm/m.model3.json', data: enc(MODEL) },
  { path: 'm/m.moc3', data: new Uint8Array(10) },
  { path: 'm/motions/idle_01.motion3.json', data: new Uint8Array(5) },
];

const hiyori: ServerAvatar = { id: 'a1', name: '日和', version: 1, zipBytes: 4e6, sha256: 'GOOD' };
const big: ServerAvatar = { id: 'a2', name: '大模型', version: 1, zipBytes: 59e6 };

function setup(opts: { list?: ServerAvatar[] | null; wifi?: boolean | null; sha?: string; failFetch?: boolean; files?: typeof FILES; kv?: ReturnType<typeof memory> } = {}) {
  const kv = opts.kv ?? memory();
  const written = new Map<string, string[]>();
  const removed: string[] = [];
  const fetched: string[] = [];
  let release: () => void = () => {};
  const fs: AvatarFs = {
    async write(id, v, files) { written.set(`${id}/v${v}`, files.map((f) => f.path)); },
    async remove(id) { removed.push(id); },
    async baseUrl(id, v) { return `http://localhost/_capacitor_file_/avatars/${id}/v${v}/`; },
  };
  let list = opts.list === undefined ? [hiyori, big] : opts.list;
  const source: AvatarSource = {
    async list() { return list; },
    fetchZip: (id) => new Promise((ok, no) => {
      fetched.push(id);
      release = () => (opts.failFetch ? no(new Error('电脑不在线,没下下来')) : ok(new Uint8Array([1, 2, 3])));
    }),
  };
  let wifi = opts.wifi === undefined ? true : opts.wifi;
  const lib = createAvatarLibrary({
    kv, fs,
    unzip: async () => opts.files ?? FILES,
    sha256: async () => opts.sha ?? 'GOOD',
    onWifi: () => wifi,
  });
  return {
    lib, kv, written, removed, fetched, source,
    finish: () => release(),
    setWifi: (w: boolean) => { wifi = w; },
    setList: (l: ServerAvatar[] | null) => { list = l; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

async function installed(t: ReturnType<typeof setup>, id = 'a1') {
  await t.lib.init();
  await t.lib.setSource(t.source);
  await t.lib.download(id);
  await tick();
  t.finish();
  await settle();
}

describe('缺省态:一个形象都没有', () => {
  it('★没配对(没有来源):只有粒子球,不知道电脑上有什么', async () => {
    const { lib } = setup();
    await lib.init();
    const s = lib.get();
    expect(s.choice).toBe(PARTICLES);
    expect(s.stage).toEqual([]);
    expect(s.entries).toEqual([]);
    expect(s.server).toBe('unknown');
  });
  it('★接上电脑但电脑上一个都没上传:明说「电脑上没有」(server ok + 空)', async () => {
    const t = setup({ list: [] });
    await t.lib.init();
    await t.lib.setSource(t.source);
    expect(t.lib.get().server).toBe('ok');
    expect(t.lib.get().entries).toEqual([]);
    expect(t.lib.get().stage).toEqual([]);
  });
  it('连不上电脑(列表拿不到):说连不上,不去别处找', async () => {
    const t = setup({ list: null });
    await t.lib.init();
    await t.lib.setSource(t.source);
    expect(t.lib.get().server).toBe('offline');
    expect(t.lib.get().entries).toEqual([]);
  });
});

describe('电脑上的形象', () => {
  it('★列出电脑上发布过的:可下载,不进左右滑的队列', async () => {
    const t = setup();
    await t.lib.init();
    await t.lib.setSource(t.source);
    const s = t.lib.get();
    expect(s.entries.map((e) => [e.id, e.name, e.state.kind])).toEqual([['a1', '日和', 'available'], ['a2', '大模型', 'available']]);
    expect(s.stage).toEqual([]);
  });
  it('★下载:取 zip → 校验 → 解压 → 认出包里的 model3.json(子目录也认)→ 落盘 → 进队列', async () => {
    const t = setup();
    await t.lib.init();
    await t.lib.setSource(t.source);
    expect(await t.lib.download('a1')).toBe('started');
    await tick();
    expect(t.lib.get().entries[0].state).toEqual({ kind: 'downloading' });
    t.finish();
    await settle();
    expect(t.fetched).toEqual(['a1']);
    expect(t.lib.get().entries[0].state).toEqual({ kind: 'installed', version: 1 });
    expect(t.written.get('a1/v1')).toEqual(FILES.map((f) => f.path));
    const item = t.lib.get().stage[0];
    expect(item).toMatchObject({ id: 'a1', name: '日和', base: 'http://localhost/_capacitor_file_/avatars/a1/v1/', entry: 'm/m.model3.json', backdrop: null });
    expect(item.subject).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    // 待机:Idle 组循环;点了才有的反应(Tap*)不进随机插播
    expect(item.idle).toEqual({ loop: ['motions/idle_01.motion3.json', 'motions/idle_02.motion3.json'], beats: ['motions/wave.motion3.json'], muteMouth: false });
    expect(t.lib.get().usedBytes).toBe(FILES.reduce((n, f) => n + f.data.length, 0));
  });
  it('校验没过:不装、删掉半成品、卡片上说清楚', async () => {
    const t = setup({ sha: 'BAD' });
    await installed(t);
    const st = t.lib.get().entries[0].state;
    expect(st.kind).toBe('failed');
    expect(st.kind === 'failed' ? st.message : '').toContain('校验');
    expect(t.removed).toContain('a1');
    expect(t.lib.get().stage).toEqual([]);
  });
  it('包里没有 model3.json:不装,说清楚', async () => {
    const t = setup({ files: [{ path: 'readme.txt', data: enc('x') }] });
    await installed(t);
    const st = t.lib.get().entries[0].state;
    expect(st.kind === 'failed' ? st.message : '').toContain('model3.json');
    expect(t.lib.get().stage).toEqual([]);
  });
  it('取 zip 没成:说原话', async () => {
    const t = setup({ failFetch: true });
    await installed(t);
    expect(t.lib.get().entries[0].state).toEqual({ kind: 'failed', message: '电脑不在线,没下下来' });
  });
  it('★大包(>20 MB)+ 不是 Wi-Fi:先问;选「连上 Wi-Fi 再下」就等着,连上自动下', async () => {
    const t = setup({ wifi: false });
    await t.lib.init();
    await t.lib.setSource(t.source);
    expect(await t.lib.download('a2')).toBe('confirm');
    t.lib.waitForWifi('a2');
    expect(t.lib.get().entries[1].state.kind).toBe('waitingWifi');
    t.lib.networkChanged();
    expect(t.lib.get().entries[1].state.kind).toBe('waitingWifi');
    t.setWifi(true);
    t.lib.networkChanged();
    await tick();
    expect(t.lib.get().entries[1].state.kind).toBe('downloading');
  });
  it('小包任何网络都不问;force 不问;没有来源时下不了', async () => {
    expect(await (async () => { const t = setup({ wifi: false }); await t.lib.init(); await t.lib.setSource(t.source); return t.lib.download('a1'); })()).toBe('started');
    expect(await (async () => { const t = setup({ wifi: false }); await t.lib.init(); await t.lib.setSource(t.source); return t.lib.download('a2', { force: true }); })()).toBe('started');
    expect(await (async () => { const t = setup(); await t.lib.init(); return t.lib.download('a1'); })()).toBe('busy');
  });
  it('★电脑上出了新版:标「有更新」,手机上那版照常能用;下了新版就用新版', async () => {
    const t = setup();
    await installed(t);
    t.setList([{ ...hiyori, version: 2 }, big]);
    await t.lib.refresh();
    expect(t.lib.get().entries[0].state).toEqual({ kind: 'update', installed: 1 });
    expect(t.lib.get().stage[0].base).toContain('/a1/v1/');
    await t.lib.download('a1'); await tick(); t.finish(); await settle();
    expect(t.lib.get().entries[0].state).toEqual({ kind: 'installed', version: 2 });
    expect(t.lib.get().stage[0].base).toContain('/a1/v2/');
  });
});

describe('选择、离线、删除', () => {
  it('★选择存下来;重开(还没连上电脑)还是它 —— 下过的形象离线也能用', async () => {
    const t = setup();
    await installed(t);
    await t.lib.select('a2'); // 没下过:不算
    expect(t.lib.get().choice).toBe(PARTICLES);
    await t.lib.select('a1');
    expect(t.kv.data.get(CHOICE_KEY)).toBe('a1');
    const again = setup({ kv: t.kv, list: null });
    await again.lib.init();
    expect(again.lib.get().choice).toBe('a1');
    expect(again.lib.get().stage.map((i) => [i.id, i.name, i.entry])).toEqual([['a1', '日和', 'm/m.model3.json']]);
    expect(again.lib.get().entries.map((e) => [e.id, e.state.kind])).toEqual([['a1', 'installed']]);
  });
  it('★删下载过的;正在用的被删了回到粒子球', async () => {
    const t = setup();
    await installed(t);
    await t.lib.select('a1');
    await t.lib.remove('a1');
    expect(t.removed).toContain('a1');
    expect(t.lib.get().choice).toBe(PARTICLES);
    expect(t.lib.get().stage).toEqual([]);
    expect(t.lib.get().entries[0].state.kind).toBe('available');
  });
  it('★10-01 那版形象包留下的老索引(只有版本号、认不出是谁):启动时清掉、删文件,选择回到粒子球', async () => {
    const kv = memory();
    kv.data.set(INDEX_KEY, JSON.stringify({ moxi: { version: 1 } }));
    kv.data.set(CHOICE_KEY, 'moxi');
    const t = setup({ kv, list: null });
    await t.lib.init();
    expect(t.removed).toEqual(['moxi']);
    expect(t.lib.get().choice).toBe(PARTICLES);
    expect(t.lib.get().entries).toEqual([]);
    expect(JSON.parse(kv.data.get(INDEX_KEY) ?? '{}')).toEqual({});
  });
});

describe('认包里的东西(纯函数)', () => {
  it('model3.json:挑最浅的一个,同深度按名字;macOS 打包留的 __MACOSX 不算', () => {
    expect(pickModelEntry(['a/b/x.model3.json', 'a/y.model3.json', 'a/m.moc3'])).toBe('a/y.model3.json');
    expect(pickModelEntry(['__MACOSX/._m.model3.json', 'm.model3.json'])).toBe('m.model3.json');
    expect(pickModelEntry(['b.model3.json', 'a.model3.json'])).toBe('a.model3.json');
    expect(pickModelEntry(['m.moc3'])).toBeNull();
  });
  it('待机:名字带 idle 的组循环;Tap / Touch 开头的是点了才有的反应,不随机播;一组都没有就都空(用模型自己的)', () => {
    expect(idlePlanFromModel(JSON.parse(MODEL) as Record<string, unknown>)).toEqual({ loop: ['motions/idle_01.motion3.json', 'motions/idle_02.motion3.json'], beats: ['motions/wave.motion3.json'], muteMouth: false });
    expect(idlePlanFromModel({ FileReferences: { Motions: { TouchHead: [{ File: 't.motion3.json' }] } } })).toEqual({ loop: [], beats: [], muteMouth: false });
    expect(idlePlanFromModel({})).toEqual({ loop: [], beats: [], muteMouth: false });
  });
});
