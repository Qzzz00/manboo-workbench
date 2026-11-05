/**
 * 设置 › 形象:陈列与下载(2026-10-01,界面稿 docs/design/形象切换/⑤⑥;设计文档第一节 1.3、1.4)。
 *
 * 10-21 起形象只从电脑来(仓库与 App 里不带模型,维护者定):电脑上 butler-server 配置后台上传、发布过的,
 * 这里才看得到、才下得了。两段:
 *   · 「在这台手机上」:粒子球 + 下载过的;正在用的描白边、角标「正在用」;占用多少;
 *   · 「电脑上的」:电脑上发布了、这台手机还没下(或有新版)的;点了就下,下完自动可用。
 * 一个形象都没有时说清楚是哪一种(没配对 / 连不上电脑 / 电脑上还没上传),以及去哪儿传。
 * 点手机上已有的 = 换成它;长按下载过的 = 删除(正在用的删了回到粒子球)。大包(> 20 MB)且不是 Wi-Fi:底部弹一句(⑥)。
 */
import { useEffect, useRef, useState } from 'react';
import { avatarLibrary, useAvatarLibrary } from './useAvatarLibrary';
import { PARTICLES, type EntryView, type LibrarySnapshot } from './library';

/** 形象从哪儿传(给没写过代码的人看:点哪几下)。 */
export const AVATAR_UPLOAD_HOWTO = '在电脑上打开工作台 › 设置 › 事务官 · 形象与音色 › 打开配置后台,在「形象」里上传 Live2D 形象包(zip),再点「发布」。';

/** 陈列页顶上那句:此刻为什么只有这些。 */
export function galleryNote(lib: Pick<LibrarySnapshot, 'server' | 'entries' | 'stage'>): string {
  const onPhone = lib.stage.length > 0;
  if (lib.server === 'unknown') return `形象放在电脑上,配对之后这里会列出电脑上发布过的形象。${onPhone ? '' : '现在只有粒子球。'}`;
  if (lib.server === 'offline') return `现在连不上电脑,看不到电脑上有哪些形象;${onPhone ? '手机上已经下过的照常能用。' : '现在只有粒子球。'}`;
  if (lib.entries.length === 0) return `电脑上还没有形象,现在只有粒子球。${AVATAR_UPLOAD_HOWTO}`;
  return '首页和横屏展示台上左右滑就能换。电脑上的点一下下载到手机;下载过的长按可以删。';
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function AvatarGalleryPage() {
  const lib = useAvatarLibrary();
  const [ask, setAsk] = useState<EntryView | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<EntryView | null>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  // 进这一页就再问一次电脑上有哪些(刚在电脑上传完,回手机上点进来就该看到)。
  useEffect(() => { void avatarLibrary().refresh(); }, []);

  // 「在手机上」按队列认(下新版的那会儿旧版还在手机上、照常能用);电脑那一段放还没下的,和下过但有事要办的(新版 / 下载中 / 失败)。
  const onHand = lib.entries.filter((e) => lib.stage.some((s) => s.id === e.id));
  const remote = lib.entries.filter((e) => !onHand.includes(e) || (e.state.kind !== 'installed'));

  const download = async (e: EntryView, force = false) => {
    const r = await avatarLibrary().download(e.id, { force });
    if (r === 'confirm') setAsk(e);
  };
  const longPress = (e: EntryView) => ({
    onPointerDown: () => { pressTimer.current = window.setTimeout(() => { if (onHand.includes(e)) setConfirmRemove(e); }, 600); },
    onPointerUp: () => window.clearTimeout(pressTimer.current),
    onPointerLeave: () => window.clearTimeout(pressTimer.current),
  });

  const card = (e: EntryView | null, section: 'phone' | 'computer') => {
    const id = e === null ? PARTICLES : e.id;
    const name = e === null ? '粒子球' : e.name;
    const current = section === 'phone' && lib.choice === id;
    const usable = section === 'phone';
    const st = e?.state;
    return (
      <li key={`${section}:${id}`} className="ba-av" data-current={current}>
        <button
          type="button"
          className="ba-av__thumb"
          data-orb={e === null}
          data-dim={!usable}
          aria-label={usable ? `用 ${name}` : `下载 ${name}`}
          onClick={() => { if (usable) void avatarLibrary().select(id); else if (e !== null && st?.kind !== 'downloading') void download(e); }}
          {...(e === null || section === 'computer' ? {} : longPress(e))}
        >
          {e !== null && <span className="ba-av__initial" aria-hidden="true">{Array.from(name)[0] ?? '?'}</span>}
          {current && <span className="ba-av__badge">正在用</span>}
          {!usable && st?.kind !== 'downloading' && <span className="ba-av__cloud" aria-hidden="true">⤓</span>}
        </button>
        <div className="ba-av__meta">
          <span className="ba-av__name">{name}</span>
          {e === null ? <span className="ba-av__state">一直都在</span>
            : section === 'phone' ? <span className="ba-av__state">{st?.kind === 'update' ? '有新版' : '已下载'}</span>
            : st?.kind === 'downloading' ? (
              <span className="ba-av__prog" role="progressbar" aria-label={`正在下载 ${name}`}>
                <span>下载中…</span>
                <i><b data-indeterminate="true" /></i>
              </span>
            )
            : st?.kind === 'waitingWifi' ? <span className="ba-av__state">等 Wi-Fi</span>
            : st?.kind === 'failed' ? <button type="button" className="ba-av__btn ba-av__btn--warn" title={st.message} onClick={() => void download(e)}>重试</button>
            : <button type="button" className="ba-av__btn" onClick={() => void download(e)}>{st?.kind === 'update' ? '更新' : '⤓'}{e.zipBytes === undefined ? '' : ` ${mb(e.zipBytes)}`}</button>}
        </div>
        {st?.kind === 'failed' && section === 'computer' && <p className="ba-av__err" role="alert">{st.message}</p>}
      </li>
    );
  };

  return (
    <div className="ba-avs">
      <p className="ba-avs__lead" role="status">{galleryNote(lib)}</p>
      <section className="ba-avs__sec">
        <div className="ba-avs__head"><h2>在这台手机上</h2>{lib.usedBytes > 0 && <span>下载的占用 {mb(lib.usedBytes)}</span>}</div>
        <ul className="ba-avs__grid">{card(null, 'phone')}{onHand.map((e) => card(e, 'phone'))}</ul>
      </section>
      {remote.length > 0 && (
        <section className="ba-avs__sec">
          <div className="ba-avs__head"><h2>电脑上的</h2><span>按需,下完就能滑到</span></div>
          <ul className="ba-avs__grid">{remote.map((e) => card(e, 'computer'))}</ul>
        </section>
      )}

      {ask !== null && (
        <div className="ba-sheet" role="dialog" aria-label={`下载 ${ask.name}`}>
          <div className="ba-sheet__card ba-avsheet">
            <div className="ba-avsheet__head">
              <span className="ba-avsheet__thumb"><span className="ba-av__initial" aria-hidden="true">{Array.from(ask.name)[0] ?? '?'}</span></span>
              <span>
                <b>{ask.name}</b>
                <small>{ask.zipBytes === undefined ? '' : `${mb(ask.zipBytes)} · `}现在用的是移动网络</small>
              </span>
            </div>
            <p className="ba-avsheet__note">超过 20 MB 又没连 Wi-Fi 时才会问。下完自动出现在左右滑的队列里。</p>
            <button type="button" className="ba-btn" onClick={() => { avatarLibrary().waitForWifi(ask.id); setAsk(null); }}>连上 Wi-Fi 再自动下</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void download(ask, true); setAsk(null); }}>现在用流量下载{ask.zipBytes === undefined ? '' : `(${mb(ask.zipBytes)})`}</button>
          </div>
        </div>
      )}
      {confirmRemove !== null && (
        <div className="ba-sheet" role="dialog" aria-label={`删除 ${confirmRemove.name}`}>
          <div className="ba-sheet__card">
            <p className="ba-sheet__title">从手机上删掉「{confirmRemove.name}」?</p>
            <p className="ba-settings__line ba-settings__dim">电脑上那份还在,之后想用再下载就行。</p>
            <button type="button" className="ba-btn ba-btn--danger" onClick={() => { void avatarLibrary().remove(confirmRemove.id); setConfirmRemove(null); }}>删掉</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setConfirmRemove(null)}>算了</button>
          </div>
        </div>
      )}
    </div>
  );
}
