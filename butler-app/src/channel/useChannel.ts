/**
 * 通道层接到界面上的那一层(2026-09-17)。舞台页挂它,做四件事:
 *
 *   1. **顶上那条细横幅**:此刻是直连 / 远程 / 未连接。**不弹窗**(Ben:切换是自动的,别打扰)。
 *   2. **第二套配对**:手上没有房间凭证就向 8791 要一张(配对刚成功、或者换了台工作台时)。
 *      要不到不吵——那多半是此刻不在局域网里,回家连一次就有了。
 *   3. **续期**:到点(过期前十分钟)换一张。续不上就过一会儿再试,不打断任何事。
 *   4. **收文件**:工人发过来的文件存到手机上,并在字幕位说一句「收到了什么、存哪儿了」。
 *
 * 2026-09-25(卡 J「手机从电脑取文件」)多了三样:
 *   5. **正在收**:几十 MB 的文件屏幕上有个数在动(`incoming`);断在半路说断在百分之几;
 *      电脑那边推不过去(`file_status`)说为什么;
 *   6. **取**:首页输入框里打「把 X 发我」→ 卡上点了某一个 → `pull`:在家直接下载,在外面让电脑经房间推;
 *   7. **收到的文件**:列表(`received`)、打开、分享;「收到了」那一句点一下就打开它。
 *
 * 2026-10-04(卡 `claude/phone-file-send-loop`)多了两样:
 *   8. **电脑主动推过来的卡**(`pushedAsk`):事务官找到了她要的那个文件,卡直接摆到这台手机上 ——
 *      她**不用再说一遍**。10-04 早上事务官只能回「你在手机上再打一句『把官网逐字稿发我』」,
 *      而那件事已经被记成了完成。每隔几秒问一次 `GET /files/pending`(在家直连、出门经房间)。
 *   9. **收到了报一句**(`reportFileReceived`):文件写进盘、sha256 对上了就报个回执 ——
 *      电脑那边凭回执把那张卡挪进「完成」(没有回执就不算办完)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../session';
import { WBCH_MODE_TEXT, type WbchMode } from './channelProtocol';
import type { WbchCredential } from './credentialStore';
import { fetchWbchDevices, fetchWbchTransfers, type WbchDevice, type WbchTransfer } from './devices';
import { saveWbchFile, type WbchFileSinkDeps } from './fileSink';
import { fetchPendingFileAsks, progressText, pullFileOffer, reportFileReceived, type FileAsk, type FileAskHit } from '../files/fileFetch';
import {
  listReceivedFiles,
  openReceivedFile,
  receivedFromSaved,
  shareReceivedFile,
  type FileOpenerDeps,
  type ReceivedFile,
  type ReceivedFilesDeps,
} from '../files/receivedFiles';

/** 正在收的那一个(进度那一行)。 */
export interface WbchIncoming {
  name: string;
  received: number;
  total?: number;
  /** 直连下载(`direct`)还是经房间推过来(`room`)。 */
  via: 'direct' | 'room';
  /** 给人看的那一句。 */
  text: string;
}

export interface WbchChannelHandle {
  mode: WbchMode;
  /** 「直连」/「远程」/「未连接」。 */
  modeText: string;
  credential: WbchCredential | null;
  /** 刚收到文件那一句(或者没存下来那一句)。显示完由界面清掉。 */
  notice: string | null;
  /** 那一句对应的文件(收到了才有):点那一句就打开它。 */
  noticeFile: ReceivedFile | null;
  clearNotice(): void;
  /**
   * 发一个文件。`to` 是目标设备的 identity(2026-09-21):房里可能有好几台,
   * 发之前要挑一台。不给就发给房里所有人(老行为,给没有设备表时兜底)。
   */
  sendFile(file: File, to?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 此刻在线的别的设备(不含这台手机自己)。 */
  devices: readonly WbchDevice[];
  /** 设备表取不到 / 已经旧了时的一句人话。**原样显示**,不拿空列表冒充「没有别的设备」。 */
  devicesNote: string | null;
  /** 最近的传输记录(记录面板里列)。 */
  transfers: readonly WbchTransfer[];
  /** 打开「发文件」或记录面板时问一遍。 */
  refresh(): Promise<void>;
  /** 正在收的那一个(没有就 null)。 */
  incoming: WbchIncoming | null;
  /**
   * 取卡上的某一个(2026-09-25)。在家直接下载;在外面让电脑经房间推。
   *
   * `file` = 直连那条路当场存好的那一行(2026-10-12 多出来的:通话中那个视频弹窗要拿它的
   * `file://` 地址在 App 里放)。经房间那条路字节随后才到,这里就没有 —— 那时候由
   * `noticeFile` 接手(存好了才有)。
   */
  pull(hit: FileAskHit): Promise<{ ok: true; file?: ReceivedFile } | { ok: false; error: string }>;
  /**
   * **电脑主动推过来的那张卡**(2026-10-04):事务官找到了她要的文件,卡摆在这台手机名下。
   * 没有就 null。她点了某一个之后由界面清掉(`clearPushedAsk`),取到了那一头自己也会撤。
   */
  pushedAsk: FileAsk | null;
  clearPushedAsk(): void;
  /** 收到的文件(「文档 / 事务官」里的,新的在前)。 */
  received: readonly ReceivedFile[];
  receivedNote: string | null;
  refreshReceived(): Promise<void>;
  openFile(file: ReceivedFile): Promise<void>;
  shareFile(file: ReceivedFile): Promise<void>;
}

/** 两次续期之间最少隔这么久。防的是「续到的还是一张过期凭证」时的空转。 */
const MIN_RENEW_GAP_MS = 5000;

/**
 * 续期没成之后还要不要再排一次(2026-10-03,卡 claude/device-revoke-complete)。
 *
 * 一句话:**除了「电脑明说不认这台手机」,都再试**。那一条(从账号里移除 / 本机解除配对)
 * 不是「过一会儿可能就好」,重试一万次也是同一句话;首页那一块会带她去「重新扫码配对」
 * (stage/linkHealth.ts 的 revoked 那一路)。写成一个纯函数是为了它能被单独钉住 ——
 * 那个循环本身是个 effect,错在这一条判断上时测不出来。
 */
export function wbchShouldRetryRenew(result: { ok: boolean; revoked?: true }): boolean {
  return !result.ok && result.revoked !== true;
}

/** 经房间取文件时,电脑说「开始推了」之后最多等多久字节开始进来。 */
export const PULL_START_WAIT_MS = 20000;

/**
 * 隔多久问一次「电脑有没有推过来的卡」(2026-10-04)。
 *
 * 5 秒:她在手机上说完一句、事务官找完文件也就是几秒到几十秒,等太久她会以为没人理;
 * 再短就是在给出门那条路(经房间代理)白添流量。**只在首页挂着的时候问**(这个 hook 在那一页)。
 */
export const PENDING_ASK_POLL_MS = 5000;

export interface UseChannelOptions {
  /** 续不上时隔多久再试。缺省 1 分钟。 */
  retryMs?: number;
  /** 测试注入:不碰 Capacitor 的文件系统。 */
  sink?: WbchFileSinkDeps;
  /** 测试注入:列「收到的文件」不碰原生。 */
  list?: ReceivedFilesDeps;
  /** 测试注入:打开 / 分享不碰原生。 */
  opener?: FileOpenerDeps;
  /** 测试注入:经房间取文件时等字节开始进来多久。 */
  pullStartWaitMs?: number;
  /** 测试注入:隔多久问一次「电脑有没有推过来的卡」。0 = 不问(既有那一批用例一个字不动)。 */
  pendingPollMs?: number;
}

export function useChannel(session: Session, options: UseChannelOptions = {}): WbchChannelHandle {
  const retryMs = options.retryMs ?? 60000;
  const [mode, setMode] = useState<WbchMode>(() => session.client.mode());
  const [credential, setCredential] = useState<WbchCredential | null>(() => session.channel.credential());
  const [notice, setNoticeText] = useState<string | null>(null);
  const [noticeFile, setNoticeFile] = useState<ReceivedFile | null>(null);
  const [incoming, setIncoming] = useState<WbchIncoming | null>(null);
  const [pushedAsk, setPushedAsk] = useState<FileAsk | null>(null);
  /** 她已经点过 / 关掉过的那几张(按卡 id):别一拍一拍地弹回来。 */
  const dismissedAsksRef = useRef(new Set<string>());
  const [received, setReceived] = useState<readonly ReceivedFile[]>([]);
  const [receivedNote, setReceivedNote] = useState<string | null>(null);
  const sinkRef = useRef(options.sink);
  sinkRef.current = options.sink;
  const listRef = useRef(options.list);
  listRef.current = options.list;
  const openerRef = useRef(options.opener);
  openerRef.current = options.opener;
  /** 经房间取、还在等字节的那几个(名字 → 放弃的计时器)。收到 / 失败就清。 */
  const waitingRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** 字节已经在进来的那几个(名字)。等太久的计时器到点时看它:动过就不打断。 */
  const flowingRef = useRef(new Set<string>());

  const setNotice = useCallback((text: string | null, file: ReceivedFile | null = null) => {
    setNoticeText(text);
    setNoticeFile(file);
  }, []);

  const refreshReceived = useCallback(async () => {
    const listed = await listReceivedFiles(listRef.current ?? {});
    setReceived(listed.files);
    setReceivedNote(listed.note ?? null);
  }, []);

  /** 不等了:放掉取文件那一份房间持有,并把「还在等的」清掉。 */
  const stopWaiting = useCallback((name?: string) => {
    const waiting = waitingRef.current;
    if (name === undefined) {
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
    } else {
      const timer = waiting.get(name);
      if (timer !== undefined) clearTimeout(timer);
      waiting.delete(name);
    }
    if (waiting.size === 0) void session.channel.releasePull?.().catch(() => {});
  }, [session]);

  // ——— 横幅 ———
  useEffect(() => {
    setMode(session.client.mode());
    return session.client.subscribe(setMode);
  }, [session]);

  // ——— 凭证:有就用,没有就要一张 ———
  useEffect(() => {
    let alive = true;
    const off = session.channel.subscribe(() => { if (alive) setCredential(session.channel.credential()); });
    void (async () => {
      if (session.channel.credential() === null) {
        // 要不到不吵:多半是此刻不在局域网里。回家连一次就有了。
        await session.channel.refresh().catch(() => ({ ok: false as const, error: '' }));
      }
      if (alive) setCredential(session.channel.credential());
    })();
    return () => { alive = false; off(); };
  }, [session]);

  // ——— 续期 ———
  useEffect(() => {
    if (credential === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (delay: number) => {
      // 下限 MIN_RENEW_GAP_MS:万一续到的还是一张过期的,别在这儿空转成一个死循环。
      timer = setTimeout(() => {
        void session.channel.renewNow().then((r) => {
          if (!alive) return;
          // 续上了 → credential 变了,这个 effect 会带着新的到期时间重排一遍,不在这儿再排。
          // 没续上 → 过一会儿再试(判据见 wbchShouldRetryRenew:只有「不认这台手机」不再试)。
          if (wbchShouldRetryRenew(r)) arm(retryMs);
        });
      }, Math.max(MIN_RENEW_GAP_MS, delay));
    };
    arm(session.channel.renewDelayMs());
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer); };
  }, [session, credential, retryMs]);

  // ——— 收文件 ———
  useEffect(() => {
    return session.channel.onFile((file) => {
      void (async () => {
        const sha256 = file.attributes?.sha256;
        const saved = await saveWbchFile({ ...file, ...(sha256 === undefined ? {} : { sha256 }) }, sinkRef.current ?? {});
        setIncoming(null);
        stopWaiting(file.name);
        if (!saved.ok) {
          setNotice(`收到「${file.name}」但没存下来:${saved.error}`);
          return;
        }
        const row = receivedFromSaved(saved.saved);
        setNotice(`收到「${saved.saved.name}」,存在${saved.saved.where}${row === null ? '' : ',点这里打开'}`, row);
        if (row !== null) setReceived((list) => [row, ...list.filter((one) => one.path !== row.path)]);
      })();
    });
  }, [session, setNotice, stopWaiting]);

  // ——— 正在收(2026-09-25) ———
  useEffect(() => {
    const off = session.channel.onFileProgress?.((progress) => {
      if (progress.failed !== undefined) {
        setIncoming(null);
        stopWaiting(progress.name);
        setNotice(`「${progress.name}」没收完:${progress.failed}。再要一次就是`);
        return;
      }
      if (progress.done === true) return; // 紧接着 onFile 会接手(存盘、说一句)
      if (progress.received > 0) flowingRef.current.add(progress.name);
      setIncoming({
        name: progress.name,
        received: progress.received,
        ...(progress.total === undefined ? {} : { total: progress.total }),
        via: 'room',
        text: progressText(progress),
      });
    });
    return () => { off?.(); };
  }, [session, setNotice, stopWaiting]);

  // ——— 电脑那边推不过去(2026-09-25) ———
  useEffect(() => {
    const off = session.channel.onFileStatus?.((status) => {
      if (status.ok) return;
      setIncoming(null);
      stopWaiting(status.name);
      setNotice(`「${status.name}」没发过来:${status.error ?? '电脑没说原因'}`);
    });
    return () => { off?.(); };
  }, [session, setNotice, stopWaiting]);

  // 离开这一页时不再等(放掉取文件那一份房间持有)。
  useEffect(() => () => { stopWaiting(); }, [stopWaiting]);

  // ——— 在线设备与传输记录(2026-09-21) ———
  const [devices, setDevices] = useState<readonly WbchDevice[]>([]);
  const [devicesNote, setDevicesNote] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<readonly WbchTransfer[]>([]);

  const refresh = useCallback(async () => {
    const identity = session.channel.credential()?.identity ?? null;
    const [online, records] = await Promise.all([
      fetchWbchDevices(session.client, identity),
      fetchWbchTransfers(session.client),
    ]);
    setDevices(online.devices);
    setDevicesNote(online.note ?? null);
    setTransfers(records);
  }, [session]);

  const sendFile = useCallback(async (file: File, to?: string) => {
    const target = devices.find((device) => device.identity === to);
    const result = await session.channel.sendFile(file, to);
    setNotice(result.ok
      ? `「${file.name}」已经发给${target?.name ?? '电脑上的事务官'}了`
      : `发不出去:${result.error}`);
    // 发完把记录补上 —— 收发两头各留一条,手机这一侧看的就是工人报上去的那一份。
    if (result.ok) void refresh().catch(() => { /* 记录晚一点再刷也行 */ });
    return result;
  }, [session, devices, refresh, setNotice]);

  // ——— 取(2026-09-25) ———
  const pullStartWaitMs = options.pullStartWaitMs ?? PULL_START_WAIT_MS;
  const pull = useCallback(async (hit: FileAskHit): Promise<{ ok: true; file?: ReceivedFile } | { ok: false; error: string }> => {
    setNotice(null);
    setIncoming({ name: hit.name, received: 0, ...(hit.bytes > 0 ? { total: hit.bytes } : {}), via: session.client.mode() === 'direct' ? 'direct' : 'room', text: `正在要「${hit.name}」…` });
    const outcome = await pullFileOffer(hit, {
      mode: () => session.client.mode(),
      direct: session.direct,
      ...(session.channel.pullOffer === undefined ? {} : { pullViaRoom: (offer: string) => (session.channel.pullOffer as NonNullable<typeof session.channel.pullOffer>)(offer) }),
      onProgress: (bytes, total) => {
        const all = total ?? (hit.bytes > 0 ? hit.bytes : undefined);
        setIncoming({ name: hit.name, received: bytes, ...(all === undefined ? {} : { total: all }), via: 'direct', text: progressText({ name: hit.name, received: bytes, ...(all === undefined ? {} : { total: all }) }) });
      },
      ...(sinkRef.current === undefined ? {} : { sink: sinkRef.current }),
    });
    if (!outcome.ok) {
      setIncoming(null);
      setNotice(`「${hit.name}」没取回来:${outcome.error}`);
      return { ok: false, error: outcome.error };
    }
    if (outcome.via === 'direct') {
      setIncoming(null);
      /**
       * **收到了,报一句**(2026-10-04):文件已经写进「文档 / 事务官」、sha256 也对过了。
       * 电脑那边凭这条回执把那张卡挪进「完成」。报不上去不当失败(文件确实在手机上了)。
       */
      void reportFileReceived(session.client, { offer: hit.offer, ok: true, bytes: outcome.saved.bytes });
      const row = receivedFromSaved(outcome.saved);
      setNotice(`收到「${outcome.saved.name}」,存在${outcome.saved.where}${row === null ? '' : ',点这里打开'}`, row);
      if (row !== null) setReceived((list) => [row, ...list.filter((one) => one.path !== row.path)]);
      return { ok: true, ...(row === null ? {} : { file: row }) };
    }
    // 经房间:电脑说开始推了,字节随后到(onFileProgress / onFile 接手)。一直没动静就如实说。
    setIncoming({ name: hit.name, received: 0, ...(hit.bytes > 0 ? { total: hit.bytes } : {}), via: 'room', text: `电脑在推「${hit.name}」…` });
    const previous = waitingRef.current.get(hit.name);
    if (previous !== undefined) clearTimeout(previous);
    flowingRef.current.delete(hit.name);
    waitingRef.current.set(hit.name, setTimeout(() => {
      waitingRef.current.delete(hit.name);
      // 字节已经在进来了(进度动过)就不打断:传完或断了,那一头自己会收尾(持有也由那一头放)。
      if (flowingRef.current.has(hit.name)) return;
      setIncoming(null);
      setNotice(`「${hit.name}」电脑说在推,但等了 ${Math.round(pullStartWaitMs / 1000)} 秒一个字节都没到;再点一次试试`);
      if (waitingRef.current.size === 0) void session.channel.releasePull?.().catch(() => {});
    }, pullStartWaitMs));
    return { ok: true };
  }, [session, setNotice, pullStartWaitMs]);

  /**
   * **电脑推过来的卡,每隔几秒问一次**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   *
   * 为什么要轮询:那张卡以前只能跟在她那句话的回包里,事务官自己找到文件之后**没有任何办法
   * 把卡摆到她面前** —— 10-04 早上它只能叫她再说一遍。这一条就是那条路。
   *
   * **问不到就当这一拍没有**:不清掉手上这张、不编一张(D13)。她点过 / 关过的不再弹回来。
   */
  const pendingPollMs = options.pendingPollMs ?? PENDING_ASK_POLL_MS;
  useEffect(() => {
    if (pendingPollMs <= 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const asks = await fetchPendingFileAsks(session.client).catch(() => []);
      if (!alive) return;
      const fresh = asks.find((ask) => !dismissedAsksRef.current.has(ask.id));
      if (fresh !== undefined) setPushedAsk((now) => (now?.id === fresh.id ? now : fresh));
      timer = setTimeout(() => { void tick(); }, pendingPollMs);
    };
    void tick();
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer); };
  }, [session, pendingPollMs]);

  const clearPushedAsk = useCallback(() => {
    setPushedAsk((now) => {
      if (now !== null) dismissedAsksRef.current.add(now.id);
      return null;
    });
  }, []);

  const openFile = useCallback(async (file: ReceivedFile) => {
    const opened = await openReceivedFile(file, openerRef.current ?? {});
    if (!opened.ok) setNotice(`「${file.name}」没打开:${opened.error}`);
  }, [setNotice]);

  const shareFile = useCallback(async (file: ReceivedFile) => {
    const shared = await shareReceivedFile(file, openerRef.current ?? {});
    if (!shared.ok) setNotice(`「${file.name}」没分享出去:${shared.error}`);
  }, [setNotice]);

  return {
    mode,
    modeText: WBCH_MODE_TEXT[mode],
    credential,
    notice,
    noticeFile,
    clearNotice: useCallback(() => setNotice(null), [setNotice]),
    sendFile,
    devices,
    devicesNote,
    transfers,
    refresh,
    incoming,
    pull,
    pushedAsk,
    clearPushedAsk,
    received,
    receivedNote,
    refreshReceived,
    openFile,
    shareFile,
  };
}
