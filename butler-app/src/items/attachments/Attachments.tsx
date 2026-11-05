/**
 * 对话里的附件:一排卡 + 点开全屏看(2026-10-01,手机读对话卡 C)。
 *
 * 统筹口径:**任何文件至少有一张卡**(名字、类型、大小、缩略图;出不了缩略图就画类型),能读的就显示内容 ——
 *   图片(双指缩放、左右滑同一条对话里的下一张)、视频 / 声音(能播就播,播不了如实说到电脑上看)、
 *   md(按格式)、代码 / 文本(等宽、能横滑)、表格、网页(放进不跑脚本、不联网的框)、PDF(一页一张图,能缩放、左右翻)。
 * 转换都在 Mac 上做;电脑不在线时卡上只有名字和类型,写「电脑不在线,打不开」。
 */
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { SessionAttachmentInfo, SessionAttachmentRef } from '../../api/protocol';
import { Markdown } from '../../ui/Markdown';
import { ZoomImage } from './ZoomImage';
import {
  ATTACHMENT_KIND_TITLES,
  ATTACHMENT_MISSING,
  ATTACHMENT_OFFLINE,
  attachmentFull,
  attachmentInfo,
  attachmentPage,
  attachmentText,
  attachmentThumb,
  sizeLabel,
  type AttachmentTarget,
} from './attachmentsApi';

/** 缩略图只在这台手机的内存里记一会儿(翻回来不再要一遍);不落盘。 */
const thumbs = new Map<string, string | null>();
const THUMB_KEEP = 200;
function rememberThumb(key: string, value: string | null): void {
  thumbs.set(key, value);
  if (thumbs.size > THUMB_KEEP) { const oldest = thumbs.keys().next().value; if (oldest !== undefined) thumbs.delete(oldest); }
}

function useThumb(client: ApiClient, target: AttachmentTarget, enabled: boolean): string | undefined {
  const key = `${target.agent}|${target.sessionId}|${target.ref}`;
  const [src, setSrc] = useState<string | undefined>(() => thumbs.get(key) ?? undefined);
  useEffect(() => {
    if (!enabled || thumbs.has(key)) return;
    let alive = true;
    void attachmentThumb(client, target).then((got) => {
      rememberThumb(key, got.ok ? got.value : null);
      if (alive && got.ok) setSrc(got.value);
    }).catch(() => {});
    return () => { alive = false; };
  }, [client, key, enabled]);
  return src;
}

/** 卡上那个小图:看得见了才去要(一条对话几十张截图,不一次全要)。 */
function Thumb({ client, target, kind }: { client: ApiClient; target: AttachmentTarget; kind: SessionAttachmentRef['kind'] }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || el === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((list) => { if (list.some((one) => one.isIntersecting)) setSeen(true); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  const src = useThumb(client, target, seen);
  return (
    <span ref={ref} className="ba-att__thumb" data-kind={kind}>
      {src !== undefined ? <img src={src} alt="" /> : <span className="ba-att__badge">{ATTACHMENT_KIND_TITLES[kind]}</span>}
    </span>
  );
}

export function AttachmentStrip({ client, agent, sessionId, refs, online, onOpen }: {
  client: ApiClient;
  agent: string;
  sessionId: string;
  refs: readonly SessionAttachmentRef[];
  /** 电脑在不在线(不在线就不去要,卡上写一句)。 */
  online: boolean;
  onOpen(ref: SessionAttachmentRef): void;
}) {
  return (
    <ul className="ba-att" aria-label="附件">
      {refs.map((one) => {
        const why = one.missing === true ? ATTACHMENT_MISSING : online ? undefined : ATTACHMENT_OFFLINE;
        const meta = [ATTACHMENT_KIND_TITLES[one.kind], sizeLabel(one.bytes), one.from === 'you' ? '你发的' : undefined].filter(Boolean).join(' · ');
        const body = (
          <>
            {why === undefined
              ? <Thumb client={client} target={{ agent, sessionId, ref: one.ref }} kind={one.kind} />
              : <span className="ba-att__thumb" data-kind={one.kind}><span className="ba-att__badge">{ATTACHMENT_KIND_TITLES[one.kind]}</span></span>}
            <span className="ba-att__name">{one.name}</span>
            <span className="ba-att__meta">{why ?? meta}</span>
          </>
        );
        return (
          <li key={one.ref}>
            {why === undefined
              ? <button type="button" className="ba-att__card" onClick={() => onOpen(one)}>{body}</button>
              : <div className="ba-att__card" data-off="true">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────────── 全屏看 ─────────────────────────────

type Content =
  | { kind: 'loading'; line: string }
  | { kind: 'error'; line: string }
  | { kind: 'image'; src: string }
  | { kind: 'video'; src: string }
  | { kind: 'audio'; src: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'html'; html: string }
  | { kind: 'pages'; total: number }
  /** `play` = 这是一段先没取的音视频,卡上多一颗「就在这里放」。 */
  | { kind: 'card'; thumb?: string; note: string; play?: true };

/**
 * 音视频超过这么大就先不自动整份取(2026-10-04)。
 * 8MB ≈ 16 块,出门经中转也就十几次往返;再大的让她自己选(放 / 存到手机上)。
 */
export const AUTO_FULL_MAX = 8 * 1024 * 1024;

/** 网页放进一个**不跑脚本、不联网**的框:sandbox 不给任何权限,再加一条只许内联样式与内嵌图的 CSP。 */
export function sandboxedHtml(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:12px;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%}</style>${html}`;
}

function useObjectUrl(): (blob: Blob) => string {
  const urls = useRef<string[]>([]);
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL?.(url); }, []);
  return (blob) => {
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
    urls.current.push(url);
    return url;
  };
}

function PdfPages({ client, target, total }: { client: ApiClient; target: AttachmentTarget; total: number }) {
  const [page, setPage] = useState(0);
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setSrc(undefined);
    setError(undefined);
    void attachmentPage(client, target, page).then((got) => { if (!alive) return; if (got.ok) setSrc(got.value); else setError(got.error); }).catch(() => {});
    return () => { alive = false; };
  }, [client, target.agent, target.sessionId, target.ref, page]);
  const go = (d: 1 | -1): void => setPage((p) => Math.min(total - 1, Math.max(0, p + d)));
  return (
    <div className="ba-viewer__pages">
      {src !== undefined ? <ZoomImage key={page} src={src} alt={`第 ${page + 1} 页`} onSwipe={go} /> : <p className="ba-sheet__hint" role="status">{error ?? `正在读第 ${page + 1} 页…`}</p>}
      <div className="ba-viewer__pager">
        <button type="button" className="ba-btn ba-btn--ghost" disabled={page === 0} onClick={() => go(-1)}>上一页</button>
        <span>{page + 1} / {total}</span>
        <button type="button" className="ba-btn ba-btn--ghost" disabled={page >= total - 1} onClick={() => go(1)}>下一页</button>
      </div>
    </div>
  );
}

/**
 * 这个附件在电脑上是一个真文件吗(2026-10-04)。编号里 `~p~` 是本机路径、`~k~` 是那家自己的图库
 * (Kimi 的 blobs),`~b~` 是**写在对话记录里**的 base64 —— 那一种没有对应的文件,存不下来。
 * 只有前两种才摆「存到手机上」。
 */
export function attachmentIsFile(ref: string): boolean {
  return /^\d+~[pk]~/.test(ref);
}

export function AttachmentViewer({ client, agent, sessionId, item, gallery, online, onMove, onClose, onKeep }: {
  client: ApiClient;
  agent: string;
  sessionId: string;
  item: SessionAttachmentRef;
  /** 同一条对话里的图(左右滑换着看)。 */
  gallery: readonly SessionAttachmentRef[];
  online: boolean;
  onMove(ref: SessionAttachmentRef): void;
  onClose(): void;
  /**
   * 「存到手机上」(2026-10-04):压缩包、设计稿、几百 MB 的视频这一类在手机上看不了全 ——
   * 走现成的取件单(`view=keep` → `pullFileOffer`)。回一句给人看的话。
   * 缺席 = 不摆这颗键(老的测试、电脑端不支持)。
   */
  onKeep?: (ref: SessionAttachmentRef) => Promise<string>;
}) {
  const [content, setContent] = useState<Content>({ kind: 'loading', line: '正在读…' });
  const [info, setInfo] = useState<SessionAttachmentInfo | undefined>(undefined);
  const objectUrl = useObjectUrl();
  const target: AttachmentTarget = { agent, sessionId, ref: item.ref };
  const index = gallery.findIndex((one) => one.ref === item.ref);
  /** 「存到手机上」那一下:正在取 / 取完那一句。 */
  const [keeping, setKeeping] = useState(false);
  const [keepLine, setKeepLine] = useState<string | undefined>(undefined);
  const canKeep = onKeep !== undefined && online && item.missing !== true && attachmentIsFile(item.ref);
  /** 她点了「就在这里放」:这一下才去整份取那一段大音视频。 */
  const [play, setPlay] = useState(false);

  useEffect(() => {
    let alive = true;
    const set = (next: Content): void => { if (alive) setContent(next); };
    setInfo(undefined);
    if (!online) { set({ kind: 'error', line: ATTACHMENT_OFFLINE }); return () => { alive = false; }; }
    set({ kind: 'loading', line: '正在读…' });
    void (async () => {
      const got = await attachmentInfo(client, target);
      if (!got.ok) { set({ kind: 'error', line: got.error }); return; }
      const one = got.value;
      if (alive) setInfo(one);
      const thumb = one.thumb ? await attachmentThumb(client, target) : undefined;
      /**
       * 大块头的音视频**不自己先整份下**(2026-10-04,统筹:「视频别整份几百 MB 先下载」)。
       * 整份是 512KB 一块要来拼的 —— 一段 200MB 的视频在外面就是 400 次往返。
       * 所以超过 {@link AUTO_FULL_MAX} 的先摆一张卡(第一帧 + 大小 + 一句),她点「就在这里放」才去取,
       * 或者点「存到手机上」把原件拿下来用手机自己的播放器看。图片不受这条管(图本来就小,也要能马上看)。
       */
      if (one.full !== undefined && (one.kind === 'video' || one.kind === 'audio') && one.full.bytes > AUTO_FULL_MAX && !play) {
        set({
          kind: 'card',
          ...(thumb?.ok === true ? { thumb: thumb.value } : {}),
          note: `这段${one.kind === 'video' ? '视频' : '声音'}有 ${sizeLabel(one.full.bytes) ?? '不少'},先不自动取;点「就在这里放」在手机上放,或者「存到手机上」拿原件`,
          play: true,
        });
        return;
      }
      if (one.full !== undefined && (one.kind === 'image' || one.kind === 'video' || one.kind === 'audio')) {
        if (thumb?.ok === true && one.kind === 'image') set({ kind: 'image', src: thumb.value });
        const full = await attachmentFull(client, target, one.full.parts, one.full.mime, (done, total) => {
          if (total > 1 && one.kind !== 'image') set({ kind: 'loading', line: `正在取 ${done}/${total}` });
        });
        if (!full.ok) { set({ kind: 'error', line: full.error }); return; }
        const src = objectUrl(full.value);
        set(one.kind === 'image' ? { kind: 'image', src } : one.kind === 'video' ? { kind: 'video', src } : { kind: 'audio', src });
        return;
      }
      if (one.text !== undefined) {
        const text = await attachmentText(client, target, one.text.parts);
        if (!text.ok) { set({ kind: 'error', line: text.error }); return; }
        if (text.value.rows !== undefined) set({ kind: 'table', rows: text.value.rows });
        else if (one.text.format === 'markdown') set({ kind: 'markdown', text: text.value.text ?? '' });
        else if (one.text.format === 'html') set({ kind: 'html', html: text.value.text ?? '' });
        else set({ kind: 'code', text: text.value.text ?? '' });
        return;
      }
      if (one.pages !== undefined) { set({ kind: 'pages', total: one.pages }); return; }
      set({ kind: 'card', ...(thumb?.ok === true ? { thumb: thumb.value } : {}), note: one.note ?? '完整的到电脑上打开' });
    })().catch((e: unknown) => set({ kind: 'error', line: e instanceof Error ? e.message : '连不上工作台' }));
    return () => { alive = false; };
  }, [client, agent, sessionId, item.ref, online, play]);

  // 换一个附件看:上一个「就在这里放」的选择不跟着带过去。
  useEffect(() => { setPlay(false); setKeepLine(undefined); }, [item.ref]);

  const move = (d: 1 | -1): void => {
    const next = gallery[index + d];
    if (next !== undefined) onMove(next);
  };

  return (
    <div className="ba-viewer" role="dialog" aria-label="看附件">
      <div className="ba-viewer__bar">
        <span className="ba-viewer__name">{item.name}</span>
        {index >= 0 && gallery.length > 1 && <span className="ba-viewer__count">{index + 1} / {gallery.length}</span>}
        {canKeep && (
          <button
            type="button"
            className="ba-btn ba-btn--ghost"
            disabled={keeping}
            onClick={() => {
              setKeeping(true);
              setKeepLine(`正在取「${item.name}」…`);
              void onKeep(item)
                .then(setKeepLine)
                .catch((e: unknown) => setKeepLine(e instanceof Error ? e.message : '没取回来'))
                .finally(() => setKeeping(false));
            }}
          >
            {keeping ? '正在取…' : '存到手机上'}
          </button>
        )}
        <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>关闭</button>
      </div>
      {keepLine !== undefined && <p className="ba-sheet__hint" role="status">{keepLine}</p>}
      <div className="ba-viewer__body" data-kind={content.kind}>
        {content.kind === 'loading' && <p className="ba-sheet__hint" role="status">{content.line}</p>}
        {content.kind === 'error' && <p className="ba-sheet__hint" role="status">{content.line}</p>}
        {content.kind === 'image' && <ZoomImage src={content.src} alt={item.name} onSwipe={move} />}
        {content.kind === 'video' && <VideoPlayer src={content.src} />}
        {content.kind === 'audio' && <audio controls src={content.src} className="ba-viewer__audio" />}
        {content.kind === 'markdown' && <div className="ba-viewer__doc"><Markdown text={content.text} /></div>}
        {content.kind === 'code' && <pre className="ba-viewer__code" {...(info?.text?.lang === undefined ? {} : { 'data-lang': info.text.lang })}><code>{content.text}</code></pre>}
        {content.kind === 'table' && (
          <div className="ba-viewer__table">
            <table>
              <tbody>{content.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => (r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>))}</tr>)}</tbody>
            </table>
          </div>
        )}
        {content.kind === 'html' && <iframe className="ba-viewer__html" title={item.name} sandbox="" srcDoc={sandboxedHtml(content.html)} />}
        {content.kind === 'pages' && <PdfPages client={client} target={target} total={content.total} />}
        {content.kind === 'card' && (
          <div className="ba-viewer__card">
            {content.thumb !== undefined && <img src={content.thumb} alt="" />}
            <p>{[ATTACHMENT_KIND_TITLES[item.kind], sizeLabel(info?.bytes ?? item.bytes)].filter(Boolean).join(' · ')}</p>
            <p className="ba-sheet__hint">{content.note}</p>
            {content.play === true && (
              <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setPlay(true)}>就在这里放</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 视频:能播就播;播不了(HEVC 之类安卓不认)如实说,不黑屏。 */
function VideoPlayer({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  return broken
    ? <p className="ba-sheet__hint" role="status">这段视频手机上放不了,到电脑上看</p>
    : <video className="ba-viewer__video" controls playsInline src={src} onError={() => setBroken(true)} />;
}
