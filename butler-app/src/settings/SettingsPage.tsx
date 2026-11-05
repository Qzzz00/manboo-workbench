/**
 * 设置(2026-09-27 重排,卡 SZ2;梳理与前后对照见 docs/梳理-0927-手机设置页.md)。
 *
 * 维护者 09-27 的原话:「手机上的现在设置页面的逻辑非常混乱……我自己用都用不利索了」。
 * 以前这一页是**一条没有分组的长卷**:十二节一路排下来、约十屏,排的顺序是「谁先写的谁在上面」——
 * 她每天真会碰的(免打扰时段、朗读、大字)在第五屏往后,而装一次就再也不碰的
 * (退出登录、房间凭证、令牌)霸着头几屏。
 *
 * 现在:首屏**八行分组**(表在 settingsNav.ts,按「她多久碰一次」从上往下),点一行进子页。
 *   - 地址、端口、设备号、房间、服务器地址**一律不上屏** —— 要给维护者看的收进「高级」;
 *   - 「添加座机」「给座机换网络」是**真的独立子页**(SubPage,带「‹ 返回」,系统返回接得住)——
 *     以前它们原地把「座机」那一节换掉,屏上却还写着「设置」,按系统返回直接弹回首页、六步白走;
 *   - 顶上那条返回头由这一页自己摆(以前在 App.tsx 里写死「设置」)—— 页名要跟着层走。
 *
 * **每一项自己的行为一个字没动**:同样的请求、同样的开关、同样的文案,只换了位置与层级。
 * 名字上还有四条待拍板(梳理第六节:「登录」改不改名、「高级」去不去、资讯并不并、
 * 那只话筒两端叫什么)—— 这一版**一个名字都不改**。
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session';
import { WBCH_MODE_TEXT, wbchExpiryText } from '../channel/channelProtocol';
import { desktopStatusText, loggedInLine, workbenchLabelOnScreen } from '../login/loginModel';
import { useSettings } from '../settings/SettingsContext';
import { useFeed, useAppearance } from '../hooks';
import { useLargeText } from './largeText';
import { TestTicketsSection } from './TestTicketsSection';
import { DiagSendSection } from './DiagSendSection';
import { DISPLAY_STYLES, useDisplayStyle } from '../display/displayStyle';
import { APPEARANCE_SYNCED_TEXT } from '../swarm/appearance';
import type { AvatarSummary } from '../api/voice';
import { CallAlertsSection, HandsetSection } from './DeskPhoneSection';
import { NewsSettings } from '../feed/NewsSettings';
import { RulesSection } from './RulesSection';
import { HabitsSection } from './HabitsSection';
import { AgentCapsSection } from './AgentCapsSection';
import { AddHandsetPage } from '../handset/AddHandsetPage';
import { SwitchNetworkPage } from '../handset/SwitchNetworkPage';
import { SubPage } from '../nav/BackHeader';
import { useBackHandler } from '../nav/back';
import { SETTINGS_GROUPS, SETTINGS_ROOT_TITLE, SETTINGS_TITLES, type SettingsNode } from './settingsNav';
import { PhoneUpdateSection } from '../update/PhoneUpdateSection';
import { AVATAR_UPLOAD_HOWTO } from '../avatars/AvatarGalleryPage';
import { buildStampLine, usePhoneBuildStamp } from '../update/buildStamp';
import { RouteSection, useRouteView } from '../channel/RouteBanner';
import { ROUTE_TITLE_TEXT } from '../channel/routeDriver';

/**
 * 这两样 2026-10-03 挪进了 `update/phoneUpdate.ts`(手机包那一节整块搬过去了,卡
 * claude/phone-in-app-update)。这里原样再导出一次 —— 它们的消费方不止这一页。
 */
export { OFFICIAL_SITE, apkSizeText } from '../update/phoneUpdate';

export function SettingsPage({ avatars, onBack, onOpenOnboarding, onOpenAvatars }: {
  avatars: readonly AvatarSummary[];
  /** 首屏「形象」那一行:进形象陈列与下载(2026-10-01,和首页形象区顶上那颗小方格同一页)。 */
  onOpenAvatars?: () => void;
  /** 首屏那一层的「‹」:回首页。App.tsx 传 goHome。 */
  onBack?: () => void;
  onOpenOnboarding?: () => void;
}) {
  const session = useSession();
  const { settings, update } = useSettings();
  const feed = useFeed(session.feed);
  const largeText = useLargeText();
  const displayStyle = useDisplayStyle();
  const appearance = useAppearance(session.appearance);
  /**
   * 这个包自己是哪一版(2026-10-03,维护者:「包也没有版本号」)。读构建时写进去的 build.json
   * (update/buildStamp.ts);**读不到就整行缺席**,不编一个版本号。
   */
  const buildLine = buildStampLine(usePhoneBuildStamp());
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  /** 在家 / 出门(局域网 M4)。网页里、老会话没有路线:那一节不出现。 */
  const routeView = useRouteView(session.route);
  const [credential, setCredential] = useState(() => session.channel.credential());
  const [refreshing, setRefreshing] = useState<'idle' | 'busy' | string>('idle');
  useEffect(() => {
    setCredential(session.channel.credential());
    return session.channel.subscribe(() => setCredential(session.channel.credential()));
  }, [session]);

  /**
   * 这一页此刻在第几层。空 = 首屏那八行;一层 = 某一组;两层 = 座机里那两条流程。
   * 用一根栈而不是一个 `page` 字段:返回要**退一层**,不是回首屏。
   */
  const [stack, setStack] = useState<readonly SettingsNode[]>([]);
  const node = stack.length === 0 ? undefined : stack[stack.length - 1];
  const push = useCallback((one: SettingsNode) => setStack((s) => [...s, one]), []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  /**
   * 系统返回键:在子页上**退一层**,不弹回首页。
   * 壳那一层(App.tsx,BACK_PAGE)比这一层低,所以首屏那一层才轮到它 → 回首页。
   * 两条座机流程自己也登记一层(它们登记得更晚,所以在它们身上按返回先关它们)。
   */
  useBackHandler(node !== undefined, pop);

  // ——— 两条配座机的流程:它们自己是一整页,不套在这一页的返回头里 ———
  if (node === 'addHandset') return <AddHandsetPage onClose={pop} />;
  if (node === 'switchNetwork') return <SwitchNetworkPage onClose={pop} />;

  /** 首屏那一行分组后面跟的一句现状。**取不到就用那一组的介绍**,不编一个数。 */
  const nowText: Partial<Record<SettingsNode, string>> = {
    computer: routeView !== null && !routeView.deciding
      ? `${ROUTE_TITLE_TEXT[routeView.route]} · ${desktopStatusText({ kind: 'linked', mode: session.client.mode(), connected: feed.connected })}`
      : desktopStatusText({ kind: 'linked', mode: session.client.mode(), connected: feed.connected }),
    voiceLook: settings.voiceEnabled ? '朗读开着' : '朗读关着',
    about: feed.state.update_available_apk === undefined ? '' : `有新版 ${feed.state.update_available_apk.version}`,
  };

  return (
    <SubPage
      title={node === undefined ? SETTINGS_ROOT_TITLE : SETTINGS_TITLES[node]}
      onBack={node === undefined ? (onBack ?? (() => undefined)) : pop}
    >
      <div className="ba-settings">
        {/*
          顶上那一行:这个包是哪一版、什么时候构建的(2026-10-03)。
          她报一个毛病时第一句要问的就是「你手机上装的是哪一版」—— 以前这一页上答不出来。
          读不到 build.json(浏览器里调试、10-03 之前打的老包)就**整行不出现**。
        */}
        {node === undefined && buildLine !== undefined && <p className="ba-settings__line ba-settings__dim">{buildLine}</p>}
        {/* ——— 首屏:八行,一屏看完 ——— */}
        {node === undefined && (
          <ul className="ba-list">
            {SETTINGS_GROUPS.flatMap((group) => [(
              <li key={group.key}>
                <button type="button" className="ba-item ba-item--tap" onClick={() => push(group.key)}>
                  <span className="ba-item__body">
                    <span className="ba-item__title">{SETTINGS_TITLES[group.key]}</span>
                    <span className="ba-item__meta">{nowText[group.key] !== undefined && nowText[group.key] !== '' ? nowText[group.key] : group.hint}</span>
                  </span>
                  <span className="ba-item__chev" aria-hidden="true">›</span>
                </button>
              </li>
            ), ...(group.key === 'voiceLook' && onOpenAvatars !== undefined ? [(
              <li key="avatars">
                <button type="button" className="ba-item ba-item--tap" onClick={onOpenAvatars}>
                  <span className="ba-item__body">
                    <span className="ba-item__title">形象</span>
                    <span className="ba-item__meta">首页和横屏左右滑就能换;这里看全部、按需下载</span>
                  </span>
                  <span className="ba-item__chev" aria-hidden="true">›</span>
                </button>
              </li>
            )] : [])])}
          </ul>
        )}

        {/* ——— ① 我的电脑 ——— */}
        {node === 'computer' && (
          <>
            {/*
              「登录」这一节(2026-09-17,Ben:「手机上也需要有登录」)。没有账号体系,登录 = 配对。
              改不改叫「我的电脑 / 换一台电脑」是待拍板的第 1 条 —— 这一版**名字照旧**。
              09-27:那一行 `host:port · 设备 id` 从这儿去掉了,收进「高级 → 连接详情」。
            */}
            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">登录</h2>
              <p className="ba-settings__line">{loggedInLine(workbenchLabelOnScreen(session.pairing, feed.state))}</p>
              <p className="ba-settings__line">{desktopStatusText({ kind: 'linked', mode: session.client.mode(), connected: feed.connected })}</p>
              {!confirmUnpair
                ? <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setConfirmUnpair(true)}>退出登录</button>
                : (
                  <div className="ba-row">
                    <span>手机上的令牌会删掉,回到欢迎屏;工作台那边的设备记录要在电脑的设置里解除。</span>
                    <button type="button" className="ba-btn ba-btn--danger" onClick={() => { void session.unpair(); }}>确定退出</button>
                    <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setConfirmUnpair(false)}>算了</button>
                  </div>
                )}
            </section>

            {/* 在家 / 出门(局域网 M4):此刻走哪条、为什么;这个网络算不算常用由她说。 */}
            {session.route !== undefined && <RouteSection route={session.route} />}

            {/*
              「在外面也能用」(2026-09-17 通道层那张卡的「远程通道」)。出了局域网手机走的是一个房间。
              09-27:服务器地址、房间名、凭证到期、「现在取一张」全收进「高级 → 连接详情」——
              她要知道的只有一句「现在在外面连不连得上」。
            */}
            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">在外面也能用</h2>
              <p className="ba-settings__line">此刻:{WBCH_MODE_TEXT[session.client.mode()]}</p>
              {credential === null && (
                <p className="ba-settings__line ba-settings__dim">还没有房间凭证。在家里的 Wi-Fi 上连一次工作台,它会自动取一张;有了才能在外面用。</p>
              )}
              <p className="ba-settings__line ba-settings__dim">出了局域网时,所有请求会经这条加密通道由电脑上的事务官代办;语音和形象包只在局域网里取得到。</p>
            </section>
          </>
        )}

        {/* ——— ② 提醒与免打扰 ——— */}
        {node === 'alerts' && <CallAlertsSection />}

        {/* ——— ③ 声音与形象 ——— */}
        {node === 'voiceLook' && (
          <>
            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">语音</h2>
              <label className="ba-switch">
                <input type="checkbox" checked={settings.voiceEnabled} onChange={(e) => { void update({ voiceEnabled: e.target.checked }); }} />
                <span>朗读回复、按住说话</span>
              </label>
              <p className="ba-settings__line ba-settings__dim">语音靠 Mac 上的本机后端;那边没配密钥时这里自动退回文字。</p>
            </section>

            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">外观</h2>
              <p className="ba-settings__line">
                {appearance.status === 'synced' ? `${APPEARANCE_SYNCED_TEXT}(版本 ${appearance.version},${appearance.preset.settings.count} 颗)` : appearance.status === 'default' ? appearance.note : '正在向 Mac 拿外观…'}
              </p>
              <p className="ba-settings__line ba-settings__dim">粒子的数量、大小、亮度都在 Mac 的工作台「粒子外观」里调,手机只继承,不单独调。</p>
              <label className="ba-switch">
                <input type="checkbox" checked={settings.stage === 'live2d'} disabled={avatars.length === 0} onChange={(e) => { void update({ stage: e.target.checked ? 'live2d' : 'particles' }); }} />
                <span>主界面用 Live2D 形象(电脑上有已发布的形象时才能开)</span>
              </label>
              {avatars.length === 0
                ? <p className="ba-settings__line ba-settings__dim">电脑上还没有已发布的形象,主界面是粒子球。{AVATAR_UPLOAD_HOWTO}</p>
                : (
                  <ul className="ba-list">
                    {avatars.map((a) => (
                      <li key={a.id}>
                        <button type="button" className="ba-item ba-item--tap" data-selected={(settings.avatarId ?? avatars[0]?.id) === a.id} onClick={() => { void update({ avatarId: a.id }); }}>
                          <span className="ba-item__body"><span className="ba-item__title">{a.name}</span>{a.summary !== undefined && <span className="ba-item__meta">{a.summary}</span>}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">显示</h2>
              <label className="ba-switch">
                <input type="checkbox" checked={largeText.on} onChange={(e) => { void largeText.set(e.target.checked); }} />
                <span>大字</span>
              </label>
              <p className="ba-settings__line ba-settings__dim">全部文字再放大 15%,重开 App 也记得。</p>
            </section>

            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">横屏展示台样式</h2>
              {DISPLAY_STYLES.map((s) => (
                <label key={s.key} className="ba-switch">
                  <input type="radio" name="ba-display-style" checked={displayStyle.style === s.key} onChange={() => { void displayStyle.set(s.key); }} />
                  <span>{s.label}</span>
                </label>
              ))}
              <p className="ba-settings__line ba-settings__dim">{DISPLAY_STYLES.find((s) => s.key === displayStyle.style)?.hint}。转成横屏就是这一套,只存在这台手机上。</p>
            </section>
          </>
        )}

        {/* ——— ④ 记住的规矩(2026-09-24 晚,卡 K):与电脑设置里同一张表。没接规矩表的老工作台整节不出现。 ——— */}
        {/* 它学到了什么(2026-10-09):紧跟在规矩后面,同一页 —— 明说的在上、数出来的在下,各自能撤。 */}
        {node === 'rules' && (
          <>
            <RulesSection />
            <HabitsSection />
          </>
        )}

        {/* ——— ⑤ 座机:那只实体话筒。两条流程点进去是**各自一整页** ——— */}
        {node === 'handset' && (
          <HandsetSection onAdd={() => push('addHandset')} onSwitch={() => push('switchNetwork')} />
        )}

        {/* ——— ⑥ 资讯偏好(2026-09-21):自己一个组件 —— 见 feed/NewsSettings.tsx ——— */}
        {node === 'news' && <NewsSettings />}

        {/* ——— ⑦ 关于与更新 ——— */}
        {node === 'about' && (
          <>
            {/*
              手机包(2026-09-18 热更新 → 2026-09-28 卡 UP 并成一节 → **2026-10-03 改成应用内更新**)。
              09-28 定的「一节、一个动作」没改,换的是那个动作:从「打开官网」变成「下载并安装」。
              维护者 10-03 原话:「手机端现在每次更新我都得跳转官网去下载,而且包也没有版本号」。
              整块在 update/PhoneUpdateSection.tsx —— 电脑没查过、或者这一版没带手机包时它回 null。
            */}
            <PhoneUpdateSection state={feed.state} />

            {/* 发诊断包(2026-10-21,内测发版底座):出了事她自己把现场交出去,拿回一个编号发给统筹。 */}
            <DiagSendSection />

            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">引导</h2>
              <p className="ba-settings__line ba-settings__dim">{feed.state.onboarding === undefined ? '工作台没开引导' : feed.state.onboarding.done ? '引导已完成' : feed.state.onboarding.askedAt === undefined ? '还没开始' : `做到一半(${feed.state.onboarding.stage})`}</p>
              <div className="ba-row">
                <button type="button" className="ba-btn ba-btn--ghost" onClick={() => onOpenOnboarding?.()}>打开引导页</button>
              </div>
            </section>
          </>
        )}

        {/* ——— ⑧ 高级:维护调试用。**内部的东西只在这儿出现** ——— */}
        {node === 'advanced' && (
          <>
            <p className="ba-settings__line ba-settings__dim">这一组是给维护的人看的,平时不用打开。</p>

            {/* 测试单子(2026-10-01,维护者:「测试单子删了吧,都是脏数据」):她按了才删。 */}
            <TestTicketsSection />

            {/* 各家能做什么(2026-09-25,卡 O):与电脑设置同一份,只读;修要在电脑前。 */}
            <AgentCapsSection
              {...(feed.state.agent_caps === undefined ? {} : { caps: feed.state.agent_caps })}
              {...(feed.state.agent_quota === undefined ? {} : { quotas: feed.state.agent_quota })}
              agents={feed.state}
            />

            {/* 连接详情(2026-09-27 从「登录」与「远程通道」收进来):地址、端口、设备号、房间、凭证到期。 */}
            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">连接详情</h2>
              <p className="ba-settings__line ba-settings__dim">{session.pairing.host}:{session.pairing.port} · 设备 {session.pairing.deviceId}</p>
              <p className="ba-settings__line">此刻:{WBCH_MODE_TEXT[session.client.mode()]}</p>
              {routeView !== null && (
                <p className="ba-settings__line ba-settings__dim">
                  路线 {routeView.route} · 房间 {routeView.joined ?? '没进'} · 直连 {routeView.http ?? '不直连'} · 网络 {routeView.network.kind} {routeView.network.id ?? '(认不出)'} · 本地网络权限 {routeView.localNetwork}
                </p>
              )}
              {credential === null
                ? <p className="ba-settings__line ba-settings__dim">还没有房间凭证。在家里的 Wi-Fi 上连一次工作台,它会自动取一张。</p>
                : (
                  <>
                    <p className="ba-settings__line">服务器 {credential.url}</p>
                    <p className="ba-settings__line ba-settings__dim">房间 {credential.room} · 凭证{wbchExpiryText(credential.expires_at, Date.now())}(快到期时自动换,不用管)</p>
                  </>
                )}
              <div className="ba-row">
                <button
                  type="button"
                  className="ba-btn ba-btn--ghost"
                  disabled={refreshing === 'busy'}
                  onClick={() => {
                    setRefreshing('busy');
                    void session.channel.refresh().then((r) => setRefreshing(r.ok ? 'idle' : r.error));
                  }}
                >{refreshing === 'busy' ? '正在取…' : '现在取一张'}</button>
              </div>
              {/* 取不到只说一句原话,不换个说法——他要照着这句知道去哪儿修。 */}
              {refreshing !== 'idle' && refreshing !== 'busy' && <p className="ba-settings__line ba-settings__dim">{refreshing}</p>}
            </section>

            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">通话</h2>
              <label className="ba-switch">
                <input
                  type="checkbox"
                  checked={settings.callProvider === 'volc'}
                  onChange={(e) => { void update({ callProvider: e.target.checked ? 'volc' : 'livekit' }); }}
                />
                <span>退回火山 RTC 智能体接话</span>
              </label>
              <p className="ba-settings__line ba-settings__dim">缺省是 LiveKit:声音进房间,接话的是我们自己的模型(带记忆、能在电脑上办事)。这个开关是退路,LiveKit 那条真机跑不通时才打开。</p>
            </section>

            <section className="ba-settings__sec">
              <h2 className="ba-inbox__h">引导入口</h2>
              <p className="ba-settings__line ba-settings__dim">把首页上那个引导入口重新点亮(演示时用)。</p>
              <div className="ba-row">
                <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void update({ onboarding: 'pending' }); }}>重新显示引导入口</button>
              </div>
            </section>
          </>
        )}
      </div>
    </SubPage>
  );
}
