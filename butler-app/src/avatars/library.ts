/**
 * 手机上的形象库(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 第一、二节)。
 *
 * **2026-10-21 起只有一种来源**:电脑上 butler-server 上传并发布过的形象(维护者定:仓库里的模型全部出库,
 * 只留上传入口)。App 里不带任何模型、不去任何下载服务器 —— 没配对、电脑上没上传过,就只有粒子球。
 *
 * 管四件事:电脑上有哪些、这台手机上下过哪些(状态:已下载 / 可下载 / 有更新 / 下载中 / 失败 / 等 Wi-Fi)、
 * 下载(经配对会话取 zip → sha256 校验 → 解压 → 落盘 → 记索引)、当前选择(粒子球或某个形象,横竖屏同一个)、
 * 给形象舞台的队列(只含这台手机上已有的,带好本机地址)。
 * 下过的形象在本地索引里自带名字与入口,连不上电脑时照常能用。
 * 来源、文件系统、解压、网络类型都是注入的(测试塞内存实现,真机是 serverSource.ts / capacitorAvatarFs.ts)。
 */
import type { KeyValueStore } from '../api/tokenStore';

export const PARTICLES = 'particles';
/** 超过这么大、又不是 Wi-Fi 时先问一句(设计 1.4)。 */
export const CONFIRM_BYTES = 20_000_000;
export const CHOICE_KEY = 'butler.avatarChoice';
export const INDEX_KEY = 'butler.avatarIndex';

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface IdlePlan { loop: string[]; beats: string[]; muteMouth: boolean }

/** 电脑上(butler-server)发布了的一个形象。 */
export interface ServerAvatar {
  id: string;
  name: string;
  version: number;
  /** zip 字节数(下载量);电脑没说就没有。 */
  zipBytes?: number;
  sha256?: string;
}

/** 电脑那一头:列表 + 取 zip。经配对会话走(局域网直连或房间),带设备令牌。 */
export interface AvatarSource {
  /** 拿不到(电脑不在线、形象服务没起来)回 null。 */
  list(): Promise<ServerAvatar[] | null>;
  fetchZip(id: string): Promise<Uint8Array>;
}

export type EntryState =
  | { kind: 'installed'; version: number }
  | { kind: 'available' }
  | { kind: 'update'; installed: number }
  | { kind: 'downloading' }
  | { kind: 'waitingWifi' }
  | { kind: 'failed'; message: string };

export interface EntryView { id: string; name: string; zipBytes?: number; state: EntryState }

/** 电脑那头此刻:还没问过(没配对)/ 问到了 / 连不上。 */
export type ServerStatus = 'unknown' | 'ok' | 'offline';

/** 给形象舞台的一项(与 display-client hostFeed.ts 的 HostAvatarItem 同形)。 */
export interface StageItem {
  id: string; name: string; base: string; entry: string;
  subject: Box; backdrop: { phone: Box; desk: Box } | null; idle: IdlePlan;
}

export interface AvatarFs {
  /** 把解开的文件写到 <id>/v<version>/ 下。 */
  write(id: string, version: number, files: readonly { path: string; data: Uint8Array }[]): Promise<void>;
  remove(id: string): Promise<void>;
  /** <id>/v<version>/ 的本机地址(WebView 读得到的,带结尾斜杠)。 */
  baseUrl(id: string, version: number): Promise<string>;
}

export interface LibraryDeps {
  kv: KeyValueStore;
  fs: AvatarFs;
  unzip(data: Uint8Array): Promise<{ path: string; data: Uint8Array }[]>;
  sha256(data: Uint8Array): Promise<string>;
  /** 是不是 Wi-Fi;读不到回 null(当成 Wi-Fi,不问)。 */
  onWifi(): boolean | null;
}

export interface LibrarySnapshot {
  /** 电脑上的(按电脑给的顺序)+ 只在这台手机上的(电脑上删了或这会儿连不上)。 */
  entries: EntryView[];
  choice: string;
  /** 队列:这台手机上已有的。 */
  stage: StageItem[];
  /** 下载的占用(字节,解压后)。 */
  usedBytes: number;
  server: ServerStatus;
}

export type DownloadResult = 'started' | 'confirm' | 'busy';

export interface AvatarLibrary {
  get(): LibrarySnapshot;
  subscribe(listener: () => void): () => void;
  /** 读本地索引与选择、算好本机地址。启动时调一次。 */
  init(): Promise<void>;
  /** 配对会话换了(或没了):换来源并问一次电脑上有哪些。 */
  setSource(source: AvatarSource | null): Promise<void>;
  /** 再问一次电脑上有哪些(进陈列页时)。 */
  refresh(): Promise<void>;
  select(id: string): Promise<void>;
  /** `force`:不问,直接用流量下。 */
  download(id: string, opts?: { force?: boolean }): Promise<DownloadResult>;
  /** 连上 Wi-Fi 再自动下。 */
  waitForWifi(id: string): void;
  /** 网络变了(调用方挂在 connection 'change' 上):等 Wi-Fi 的那几个开始下。 */
  networkChanged(): void;
  remove(id: string): Promise<void>;
}

/** 下到这台手机上的一个(本地索引里存的就是它)。 */
interface Installed { name: string; version: number; entry: string; idle: IdlePlan; bytes: number }

const FULL: Box = { x0: 0, y0: 0, x1: 1, y1: 1 };

/** 包里的 model3.json:挑最浅的一个,同深度按名字(与 butler-server zipService 认入口同一个意思);macOS 打包的 __MACOSX 不算。 */
export function pickModelEntry(paths: readonly string[]): string | null {
  const models = paths.filter((p) => /\.model3\.json$/i.test(p) && !p.startsWith('__MACOSX/'));
  if (models.length === 0) return null;
  const depth = (p: string) => p.split('/').length;
  return [...models].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
}

/** 点了才有的反应(Tap / Touch / Flick……),没人点的屏上自己冒出来不对,不进随机插播。 */
const REACTION_GROUP = /^(tap|touch|flick|pinch|shake|hit)/i;

/**
 * 待机动作从模型自己登记的动作组里挑:名字带 idle 的组循环,其余(反应组除外)随机插播。
 * 路径照 model3.json 里写的(相对它所在目录),展示台 packModel.ts 原样塞回去。一组 idle 都没有就都空 —— 用模型自己的。
 */
export function idlePlanFromModel(settings: Record<string, unknown>): IdlePlan {
  const refs = settings.FileReferences as { Motions?: unknown } | undefined;
  const groups = typeof refs?.Motions === 'object' && refs.Motions !== null ? refs.Motions as Record<string, unknown> : {};
  const files = (list: unknown): string[] => (Array.isArray(list)
    ? list.map((m) => (typeof m === 'object' && m !== null ? (m as { File?: unknown }).File : undefined)).filter((f): f is string => typeof f === 'string')
    : []);
  const loop: string[] = [];
  const beats: string[] = [];
  for (const [name, list] of Object.entries(groups)) {
    if (/idle/i.test(name)) loop.push(...files(list));
    else if (!REACTION_GROUP.test(name)) beats.push(...files(list));
  }
  return loop.length === 0 ? { loop: [], beats: [], muteMouth: false } : { loop, beats, muteMouth: false };
}

function isInstalled(v: unknown): v is Installed {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.name === 'string' && typeof e.version === 'number' && typeof e.entry === 'string'
    && typeof e.idle === 'object' && e.idle !== null && typeof e.bytes === 'number';
}

export function createAvatarLibrary(deps: LibraryDeps): AvatarLibrary {
  let source: AvatarSource | null = null;
  let server: ServerAvatar[] = [];
  let status: ServerStatus = 'unknown';
  let index: Record<string, Installed> = {};
  let choice = PARTICLES;
  const transient = new Map<string, EntryState>();
  const bases = new Map<string, string>();
  const listeners = new Set<() => void>();
  let snap: LibrarySnapshot = { entries: [], choice, stage: [], usedBytes: 0, server: status };

  const stateOf = (id: string): EntryState => {
    const t = transient.get(id);
    if (t !== undefined) return t;
    const have = index[id];
    if (have === undefined) return { kind: 'available' };
    const s = server.find((x) => x.id === id);
    return s !== undefined && s.version > have.version ? { kind: 'update', installed: have.version } : { kind: 'installed', version: have.version };
  };

  const rebuild = () => {
    const entries: EntryView[] = server.map((s) => ({ id: s.id, name: s.name, ...(s.zipBytes === undefined ? {} : { zipBytes: s.zipBytes }), state: stateOf(s.id) }));
    for (const [id, have] of Object.entries(index)) if (!server.some((s) => s.id === id)) entries.push({ id, name: have.name, state: stateOf(id) });
    const stage: StageItem[] = [];
    for (const e of entries) {
      const have = index[e.id];
      const base = bases.get(e.id);
      if (have === undefined || base === undefined) continue;
      stage.push({ id: e.id, name: have.name, base, entry: have.entry, subject: FULL, backdrop: null, idle: have.idle });
    }
    const current = choice === PARTICLES || stage.some((s) => s.id === choice) ? choice : PARTICLES;
    const usedBytes = Object.values(index).reduce((n, e) => n + e.bytes, 0);
    snap = { entries, choice: current, stage, usedBytes, server: status };
    listeners.forEach((l) => l());
  };

  const saveIndex = () => deps.kv.set(INDEX_KEY, JSON.stringify(index));

  const run = async (s: ServerAvatar) => {
    const from = source;
    if (from === null) return;
    transient.set(s.id, { kind: 'downloading' });
    rebuild();
    try {
      const data = await from.fetchZip(s.id);
      if (s.sha256 !== undefined && (await deps.sha256(data)) !== s.sha256) throw new Error('下载的文件对不上(校验没过),没装。再试一次');
      const files = await deps.unzip(data);
      const entry = pickModelEntry(files.map((f) => f.path));
      if (entry === null) throw new Error('包里找不到模型文件(model3.json),没装');
      let idle: IdlePlan = { loop: [], beats: [], muteMouth: false };
      try {
        const settings = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === entry)?.data)) as Record<string, unknown>;
        idle = idlePlanFromModel(settings);
      } catch { /* 读不出就用模型自己的动作 */ }
      if (index[s.id] !== undefined) await deps.fs.remove(s.id);
      await deps.fs.write(s.id, s.version, files);
      index = { ...index, [s.id]: { name: s.name, version: s.version, entry, idle, bytes: files.reduce((n, f) => n + f.data.length, 0) } };
      await saveIndex();
      bases.set(s.id, await deps.fs.baseUrl(s.id, s.version));
      transient.delete(s.id);
    } catch (err) {
      try { if (index[s.id] === undefined) await deps.fs.remove(s.id); } catch { /* 半成品删不掉就算了 */ }
      transient.set(s.id, { kind: 'failed', message: err instanceof Error ? err.message : '下载没成' });
    }
    rebuild();
  };

  const refresh = async () => {
    const from = source;
    if (from === null) { server = []; status = 'unknown'; rebuild(); return; }
    let list: ServerAvatar[] | null = null;
    try { list = await from.list(); } catch { list = null; }
    if (from !== source) return; // 问的时候换了来源:以新的那次为准
    server = list ?? [];
    status = list === null ? 'offline' : 'ok';
    rebuild();
  };

  return {
    get: () => snap,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    async init() {
      let raw: Record<string, unknown> = {};
      try { const text = await deps.kv.get(INDEX_KEY); if (text) raw = JSON.parse(text) as Record<string, unknown>; } catch { raw = {}; }
      // 10-01 那版形象包(随包 / 下载服务器)留下的老索引只有版本号:那批不再有来源,清掉。
      const stale = Object.keys(raw).filter((id) => !isInstalled(raw[id]));
      index = Object.fromEntries(Object.entries(raw).filter(([, v]) => isInstalled(v))) as Record<string, Installed>;
      for (const id of stale) { try { await deps.fs.remove(id); } catch { /* 删不掉就算了 */ } }
      if (stale.length > 0) await saveIndex();
      try { const c = await deps.kv.get(CHOICE_KEY); if (c) choice = c; } catch { /* 默认粒子球 */ }
      for (const [id, have] of Object.entries(index)) bases.set(id, await deps.fs.baseUrl(id, have.version));
      if (choice !== PARTICLES && index[choice] === undefined) { choice = PARTICLES; await deps.kv.set(CHOICE_KEY, PARTICLES); }
      rebuild();
    },
    async setSource(next) {
      source = next;
      await refresh();
    },
    refresh,
    async select(id) {
      if (id !== PARTICLES && !snap.stage.some((s) => s.id === id)) return;
      choice = id;
      await deps.kv.set(CHOICE_KEY, id);
      rebuild();
    },
    async download(id, opts = {}) {
      const s = server.find((x) => x.id === id);
      if (s === undefined || source === null) return 'busy';
      if (stateOf(id).kind === 'downloading') return 'busy';
      if (opts.force !== true && (s.zipBytes ?? 0) > CONFIRM_BYTES && deps.onWifi() === false) return 'confirm';
      void run(s);
      return 'started';
    },
    waitForWifi(id) { transient.set(id, { kind: 'waitingWifi' }); rebuild(); },
    networkChanged() {
      if (deps.onWifi() === false) return;
      for (const s of server) if (transient.get(s.id)?.kind === 'waitingWifi') void run(s);
    },
    async remove(id) {
      if (index[id] === undefined) return;
      await deps.fs.remove(id);
      const { [id]: _gone, ...rest } = index;
      index = rest;
      await saveIndex();
      bases.delete(id);
      transient.delete(id);
      if (choice === id) { choice = PARTICLES; await deps.kv.set(CHOICE_KEY, PARTICLES); }
      rebuild();
    },
  };
}
