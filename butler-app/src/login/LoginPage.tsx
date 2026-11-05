/**
 * 登录第一屏(2026-09-17,Ben:「手机上也需要有登录」)。没配对过就是这一套;配对过的直接进舞台页。
 *
 * 三屏:
 *   welcome 欢迎 —— 球 + 一句话 + 「电脑端装好了吗?」两个按钮
 *   guide   指引 —— 「还没有」走这儿:说清手机为什么离不开电脑,给电脑端的获取方式(链接 + 二维码),
 *                   **底部一直在自动找电脑**;找到了就变成「找到「工作台 · xxx」,去电脑上生成配对码」并能一键进扫码
 *   pair    配对 —— 现在那张扫码页(PairPage,没重做),文案改成登录语气
 *
 * 每一屏顶上都有同一盏灯:电脑 找到了 / 没找到(登录之后在舞台页与设置页里接着显示 已连接(直连|远程)/ 不在线)。
 * 找电脑用的就是配对那套 mDNS 发现(pairing/discovery.ts),没有第二套。
 * 深链(冷启动带进来的 workbench://pair?…)直接跳到 pair,不让他先看一遍欢迎屏。
 */
import { useCallback, useEffect, useReducer, useRef, useState, type ComponentType, type MutableRefObject } from 'react';
import { PairPage } from '../pairing/PairPage';
import { startDiscovery } from '../pairing/discovery';
import type { DiscoveredWorkbench } from '../pairing/pairingMachine';
import type { QrScannerProps } from '../pairing/QrScanner';
import type { claimPairing } from '../pairing/claim';
import type { PairTarget } from '../pairing/pairUrl';
import type { Pairing } from '../api/tokenStore';
import { BlackholeHero, type HeroHandle } from '../brand/BlackholeHero';
import { prepareBrandHandoff, startBrandHandoff } from '../brand/brandHandoff';
import { DownloadQr } from './DownloadQr';
import { AccountLogin } from './AccountLogin';
import type { AccountRecord, AccountStore } from '../account/accountStore';
import { DEFAULT_RELAY_URL } from '../account/accountStore';
import { newPhoneDeviceId } from '../account/phoneLogin';
import { DESKTOP_DOWNLOAD_URL, desktopStatusText, foundDesktopLine, type LoginScreen } from './loginModel';

/** 找这么久还没有就说「没找到」。发现本身不停——它是个常驻监听,电脑随时开机随时出现。 */
const SEARCH_PATIENCE_MS = 8000;

const DISCOVERY_UNAVAILABLE_TEXT = '这台设备上找不了局域网(网页里没有这个能力)。电脑端装好之后直接去扫码。';

export interface LoginPageProps {
  onPaired(pairing: Pairing): void;
  /**
   * 账号登录成功(2026-09-21)。上层据此进主界面 —— 这台手机从此自己就能向中转领房间凭证,
   * 不必先在局域网里配过对。
   */
  onAccountLoggedIn?(account: AccountRecord): void;
  /** 账号登录态存哪儿。不传就不显示「用账号登录」那条路(老包的样子)。 */
  accountStore?: AccountStore;
  /** 中转地址。缺省是自家那台。 */
  relayUrl?: string;
  /** 深链带进来的目标。有就直接进配对屏。 */
  incoming?: PairTarget | null;
  /** 为什么回到这里(退出登录 / 令牌被撤销)。显示在欢迎屏上。 */
  notice?: string | null;
  /**
   * 首页点了「重新扫码配对」进来的(2026-09-23 第二轮从零重装):**跳过欢迎屏,直接进扫码并开相机**。
   * 维护者那天是自己进设置、退出登录、再点「装好了,去配对」、再点扫码 —— 这一格把四步收成一步。
   */
  startScan?: boolean;
  deviceName?: string;
  /** 测试注入。 */
  discover?: typeof startDiscovery;
  claim?: typeof claimPairing;
  scanner?: ComponentType<QrScannerProps>;
}

type FoundAction = { type: 'found'; workbench: DiscoveredWorkbench };

function reduceFound(list: DiscoveredWorkbench[], action: FoundAction): DiscoveredWorkbench[] {
  const same = (a: DiscoveredWorkbench) => a.host === action.workbench.host && a.port === action.workbench.port;
  return list.some(same) ? list.map((w) => (same(w) ? action.workbench : w)) : [...list, action.workbench];
}

export function LoginPage(props: LoginPageProps) {
  const {
    onPaired: paired, onAccountLoggedIn: accountLoggedIn, accountStore, relayUrl = DEFAULT_RELAY_URL,
    incoming = null, notice = null, deviceName, discover = startDiscovery, claim, scanner, startScan = false,
  } = props;
  /** 这台手机的 id。没配过对就现生成一个,**只生成一次**(每渲染换一个会把设备列表刷满)。 */
  const [phoneDeviceId] = useState(() => newPhoneDeviceId());
  /**
   * 串联(2026-09-23 品牌视觉):登录 / 配对成功那一刻,黑洞里的粒子飞出来聚成舞台页上她的球(brand/brandHandoff.ts)。
   * 先起动画再交给上层换屏;动画不拦换屏,出错也不拦。欢迎屏上有黑洞就从它接着飞,别的屏从屏幕上部现造一份。
   */
  const hero = useRef<HeroHandle | null>(null);
  // 串联的重活趁他在扫码 / 输账号时的空闲做掉,配对成功那一下不再卡(2026-09-24)。
  useEffect(() => prepareBrandHandoff(hero), []);
  const onPaired = useCallback((pairing: Pairing) => { startBrandHandoff(hero.current); paired(pairing); }, [paired]);
  const onAccountLoggedIn = accountLoggedIn === undefined
    ? undefined
    : (account: AccountRecord) => { startBrandHandoff(hero.current); accountLoggedIn(account); };
  const [screen, setScreen] = useState<LoginScreen>(incoming === null && !startScan ? 'welcome' : 'pair');
  const [autoScan, setAutoScan] = useState(incoming === null && startScan);
  const [found, addFound] = useReducer(reduceFound, [] as DiscoveredWorkbench[]);
  const [searched, setSearched] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // 深链在运行中到达(App 收到 appUrlOpen)也要把人带到配对屏。
  useEffect(() => { if (incoming !== null) setScreen('pair'); }, [incoming]);

  // 自动找电脑。配对屏交给 PairPage 自己那一份(它本来就在找),这里不重复开监听——
  // capacitor-zeroconf 的 watch/unwatch 按服务类型记账,两份同时开着,先停的那份会把另一份也停掉。
  const searching = screen !== 'pair';
  useEffect(() => {
    if (!searching) return;
    let stopped = false;
    let handle: { stop(): Promise<void> } | null = null;
    void discover({
      onFound: (workbench) => { if (!stopped) addFound({ type: 'found', workbench }); },
      onUnavailable: () => { if (!stopped) { setUnavailable(true); setSearched(true); } },
    }).then((h) => { handle = h; if (stopped) void h.stop(); });
    const timer = setTimeout(() => { if (!stopped) setSearched(true); }, SEARCH_PATIENCE_MS);
    return () => { stopped = true; clearTimeout(timer); void handle?.stop(); };
  }, [searching, discover]);

  const lamp = desktopStatusText(found.length > 0 ? { kind: 'found' } : searched ? { kind: 'missing' } : { kind: 'searching' });
  // 中转地址是空的(开源构建缺省,局域网 M7):这台没接中转,账号无处可登 —— 那条路整个不出现(局域网 M4)。
  const canUseAccount = accountStore !== undefined && onAccountLoggedIn !== undefined && relayUrl !== '';
  const goScan = () => { setAutoScan(true); setScreen('pair'); };
  // 必须稳定:PairPage 拿它当发现 effect 的依赖,每渲染换一个新函数会把 mDNS 监听反复重开。
  const noteFound = useCallback((workbench: DiscoveredWorkbench) => addFound({ type: 'found', workbench }), []);

  if (screen === 'account' && accountStore !== undefined && onAccountLoggedIn !== undefined) {
    return (
      <div className="ba-login" data-screen="account">
        <p className="ba-login__lamp">{lamp}</p>
        <AccountLogin
          relayUrl={relayUrl}
          deviceId={phoneDeviceId}
          store={accountStore}
          onLoggedIn={onAccountLoggedIn}
          onBack={() => setScreen('welcome')}
          {...(deviceName === undefined ? {} : { deviceName })}
        />
      </div>
    );
  }

  if (screen === 'pair') {
    return (
      <div className="ba-login ba-login--pair" data-screen="pair">
        <p className="ba-login__lamp">{lamp}</p>
        <PairPage
          onPaired={onPaired}
          incoming={incoming}
          notice={notice}
          autoScan={autoScan}
          onBack={() => { setAutoScan(false); setScreen('welcome'); }}
          onDiscovered={noteFound}
          seen={found}
          {...(deviceName === undefined ? {} : { deviceName })}
          {...(claim === undefined ? {} : { claim })}
          {...(scanner === undefined ? {} : { scanner })}
        />
      </div>
    );
  }

  return (
    <div className="ba-login" data-screen={screen}>
      <p className="ba-login__lamp">{lamp}</p>
      {screen === 'welcome'
        ? (
          <Welcome
            hero={hero}
            notice={notice}
            onReady={() => setScreen('pair')}
            onNotYet={() => setScreen('guide')}
            {...(canUseAccount ? { onAccount: () => setScreen('account') } : {})}
          />
        )
        : (
          <Guide
            found={found}
            searched={searched}
            unavailable={unavailable}
            onScan={goScan}
            onBack={() => setScreen('welcome')}
          />
        )}
    </div>
  );
}

/**
 * 欢迎屏。2026-09-23 起顶上是**粒子黑洞**(产品的主视觉,brand/BlackholeHero.tsx),不再是她的球 ——
 * 她在登录 / 配对成功那一下从黑洞里飞出来(维护者拍板:「从产品(黑洞)过渡到她(粒子球)」)。
 */
function Welcome({ hero, notice, onReady, onNotYet, onAccount }: {
  hero: MutableRefObject<HeroHandle | null>;
  notice: string | null;
  onReady(): void;
  onNotYet(): void;
  /** 有账号那条路时才出这颗(老包没有,界面与从前一模一样)。 */
  onAccount?(): void;
}) {
  return (
    <section className="ba-login__body">
      {notice !== null && <p className="ba-notice" role="status">{notice}</p>}
      <div className="ba-login__hero">
        <BlackholeHero handleRef={hero} />
      </div>
      <h1 className="ba-login__title">事务官</h1>
      <p className="ba-login__say">我是你的专属事务官。我的脑子和记忆都在你电脑上的工作台里,所以第一件事是把这台手机和它连起来。</p>
      <p className="ba-login__ask">电脑端装好了吗?</p>
      <div className="ba-login__acts">
        <button type="button" className="ba-btn ba-btn--big" onClick={onReady}>装好了,去配对</button>
        {onAccount !== undefined && (
          <button type="button" className="ba-btn ba-btn--ghost" onClick={onAccount}>用账号登录</button>
        )}
        <button type="button" className="ba-btn ba-btn--ghost ba-login__alt" onClick={onNotYet}>还没有</button>
      </div>
    </section>
  );
}

/** 「还没有」:说清为什么要电脑,给获取方式,底下一直找。 */
function Guide({ found, searched, unavailable, onScan, onBack }: {
  found: DiscoveredWorkbench[];
  searched: boolean;
  unavailable: boolean;
  onScan(): void;
  onBack(): void;
}) {
  return (
    <section className="ba-login__body">
      <h1 className="ba-login__title ba-login__title--sm">手机上的事务官,要连着电脑上的工作台才能用</h1>
      <p className="ba-login__say">
        事项、项目、各家会话和记忆都在电脑上跑;手机是你随身的那块屏和那只麦克风。
        电脑上没装工作台,这里就没有东西可看。
      </p>

      <div className="ba-login__get">
        <p className="ba-login__step">在电脑上打开这个地址,按说明装工作台:</p>
        <a className="ba-login__link" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">{DESKTOP_DOWNLOAD_URL}</a>
        <DownloadQr text={DESKTOP_DOWNLOAD_URL} label="电脑端下载二维码" />
        <p className="ba-login__dim">暂时指的是仓库说明页;安装包做好之后换成安装包地址。</p>
      </div>

      <div className="ba-login__watch" aria-live="polite">
        {found.length > 0
          ? (
            <>
              <p className="ba-login__step">{foundDesktopLine(found[0]!.name)}</p>
              <button type="button" className="ba-btn" onClick={onScan}>去扫码</button>
            </>
          )
          : unavailable
            ? (
              <>
                <p className="ba-login__dim">{DISCOVERY_UNAVAILABLE_TEXT}</p>
                <button type="button" className="ba-btn ba-btn--ghost" onClick={onScan}>去扫码</button>
              </>
            )
            : <p className="ba-login__dim">{searched ? '还没找到电脑。电脑上装好工作台、在设置里打开「允许手机在局域网访问」,这一行会自己变。' : '正在局域网里找电脑…'}</p>}
      </div>

      <button type="button" className="ba-btn ba-btn--ghost ba-login__alt" onClick={onBack}>返回</button>
    </section>
  );
}
