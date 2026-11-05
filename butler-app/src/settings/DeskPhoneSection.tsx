/**
 * 设置页里那两节:**提醒与免打扰**(事务官主动打来的电话)与**座机**(那只实体话筒的配网)。
 *
 * 2026-09-27(卡 SZ2,梳理 docs/梳理-0927-手机设置页.md):以前这两件事挤在同一节「座机」里 ——
 * 「座机」这个词同时管着「那只实体话筒」和「事务官打来的电话」,屏上只好加一句解释去分。
 * 现在按分组拆成两个导出:`CallAlertsSection`(进「提醒与免打扰」)与 `HandsetSection`(进「座机」)。
 * **两边的请求、文案、行为一个字没动**,只是各进了自己那一组。
 *
 * 原本的说明(2026-09-21),三样东西:
 *
 *   1. **添加座机 / 给座机换网络** —— 实体话筒(树莓派 + POP 话筒)那两条配网流程;
 *   2. **主动来电**(`GET/POST /call/config`,服务端那一份):有事时打不打、办完了打不打、夜间静默时段;
 *   3. **这台机器上到底做得到哪几样** —— 通知权限、后台/锁屏拉不拉得起来电页。做不到的**如实写出来**。
 *
 * 2026-09-25(卡 feat/first-look-orb-top,维护者:「手机的不要这个什么所谓的座机页面,就显示首页就好了...多此一举」):
 * 「座机模式(自动 / 始终 / 从不)」「放上无线充就进座机页」「拿下来 5 分钟后回到舞台」三格**去掉**,座机页整个没了。
 * 通知权限以前是在打开座机模式时顺手要的,现在挪到打开「有事的时候主动打电话给我」那一下。
 *
 * 为什么座机设置放在手机上而不是电脑上:这台机器就是接电话的那一台。
 * (服务端那两条路 `/call/config` 认的是「本机或已配对手机」,和 `/state` 同一道门。)
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session';
import { SWITCH_NETWORK_HINT, SWITCH_NETWORK_LABEL } from '../handset/SwitchNetworkPage';
import { useHandsetPresence } from '../handset/handsetPresence';
import { NearbyHandsets } from '../handset/NearbyHandsets';
import {
  DESK_PHONE_ABSENT_TEXT,
  alertHints,
  deskPhoneStatus,
  ensureNotifications,
  openFullScreenSettings,
  openNotificationSettings,
  openVendorSettings,
  requestBatteryUnrestricted,
  requestNotifications,
  setRingStandby,
  standbyHints,
  type DeskPhoneStatus,
} from '../deskphone/deskPhone';
import { useSettings } from './SettingsContext';

/**
 * 「添加座机」(2026-09-22)。说的是**那只实体话筒**(树莓派 + POP 话筒),
 * 不是上面那个「把这台手机当座机」的开关 —— 两件事同名,所以这一行下面有一句解释。
 */
export const ADD_HANDSET_LABEL = '添加座机(实体话筒)';
/**
 * 免打扰时段的两头。2026-09-26(卡 QH)把这一行从「夜间静默时段」改成「免打扰时段」:
 * 它管的**不只是铃**了 —— 同一个时段现在也管朗读、提示音(工作台把结论摆在 `/state.quiet`,
 * 手机与展示台一切出声都读它)。首页顶上那一行写的也是「免打扰中」,两处得是同一个词,
 * 不然他照着首页那句话来设置里找,找不到这一行。
 */
export const QUIET_LABEL = '免打扰时段';
/**
 * 「完成」那一类要不要响铃(2026-09-22,Ben:「『完成』类只发通知不打电话;早报也只通知,
 * 用户自己点开」)。**缺省关着** —— 这一格开着的时候才响,平时完成只发一条通知。
 */
export const DONE_CALL_LABEL = '办完了也打电话给我(默认只发一条通知)';
export { NO_FULL_SCREEN_TEXT } from '../deskphone/deskPhone';
/** 后台待机那一格(2026-10-03,缺省开)。 */
export const STANDBY_LABEL = '切到别的 App 或锁屏时也能接电话';
export const STANDBY_NOTE = '开着时状态栏会一直挂一条「随时接电话」,也会多耗一点电;关掉就只有打开事务官时才收得到电话。';
/** 提示行上那颗键。 */
export const HINT_ACTION_LABELS = { battery: '允许后台运行', vendor: '去设置', fullScreen: '去打开', notify: '打开通知', banner: '去打开' } as const;

export interface CallConfig {
  enabled: boolean;
  quiet_from: string;
  quiet_to: string;
  /** 「完成」那一类要不要真打电话(2026-09-22 Ben 定,缺省 false = 只发通知)。 */
  done_call: boolean;
}

/** 取「主动来电」那一份配置(`GET /call/config`)。取不到**不吵**、也不编一份默认值。 */
function useCallConfig() {
  const session = useSession();
  const [config, setConfig] = useState<CallConfig | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    /**
     * 取不到**不吵**:多半是这会儿连不上电脑,或者这份工作台还没有主动来电(404)。
     * 那时这一格整块不出 —— **不显示一份编出来的默认值**,那会让他以为已经设成 23:00 了。
     * `.catch` 不能省:这一条走的是 routedClient,房间那条路上什么都可能抛。
     */
    void session.client.json<CallConfig>('/call/config').then((result) => {
      if (alive && result.ok && result.data !== undefined) setConfig(result.data);
    }).catch(() => { /* 见上 */ });
    return () => { alive = false; };
  }, [session]);

  const save = useCallback(async (patch: Partial<CallConfig>) => {
    let result;
    try { result = await session.client.json<CallConfig>('/call/config', { method: 'POST', body: patch }); }
    catch (error) { setNote(`没存上:${error instanceof Error ? error.message : '连不上工作台'}`); return; }
    if (!result.ok) { setNote(`没存上:${result.error}`); return; }
    if (result.data !== undefined) setConfig(result.data);
  }, [session]);

  return { config, note, setNote, save };
}

/**
 * 「提醒与免打扰」那一组(2026-09-27 从「座机」里分出来):有事响不响、办完了响不响、免打扰时段,
 * 外加**这台机器上到底做得到哪几样**那一句 —— 它是「为什么没叫醒我」的答案,
 * 所以排在这一组第一行,不再藏在两颗配座机的按钮后面。
 */
export function CallAlertsSection() {
  const { config, note, setNote, save } = useCallConfig();
  const { settings, update } = useSettings();
  const [status, setStatus] = useState<DeskPhoneStatus | null>(null);

  const refreshStatus = useCallback(async () => { setStatus(await deskPhoneStatus()); }, []);
  useEffect(() => {
    let alive = true;
    void deskPhoneStatus().then((one) => { if (alive) setStatus(one); });
    /**
     * 从系统设置页回来再查一遍:豁免给没给、全屏通知开没开,只有回来时查得到。
     * 不在这儿编「已开」—— 以 status() 为准。
     */
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void deskPhoneStatus().then((one) => { if (alive) setStatus(one); });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  /** 提醒那一行上的键。做完当场再查一遍(从系统设置回来时 visibilitychange 也会查)。 */
  const runAlertAction = useCallback(async (action: 'notify' | 'banner' | 'fullScreen') => {
    if (action === 'notify') await ensureNotifications();
    else if (action === 'banner') await openNotificationSettings();
    else await openFullScreenSettings();
    await refreshStatus();
  }, [refreshStatus]);

  /** 开 / 关后台待机。存设置是主,原生那一下由 useIncoming 跟着设置走;这里只为当场刷新那几行。 */
  const toggleStandby = useCallback(async (on: boolean) => {
    await update({ ringStandby: on });
    await setRingStandby(on);
    await refreshStatus();
  }, [update, refreshStatus]);

  /**
   * 「有事的时候主动打电话给我」打开的那一下,顺手要一次通知权限(2026-09-25 从座机模式那一格挪过来):
   * 没有它,App 在后台或锁屏时叫不醒他。**要不到也照开** —— 前台时来电页照样弹,如实说一句就够了。
   */
  const toggleCalls = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const granted = await requestNotifications();
      setNote(granted ? null : '没有通知权限:App 在后台或锁屏时叫不醒你');
      setStatus(await deskPhoneStatus());
    }
    await save({ enabled });
  }, [save, setNote]);

  return (
    <section className="ba-settings__sec">
      <h2 className="ba-inbox__h">提醒</h2>

      {status !== null && status.absent && (
        <p className="ba-settings__line ba-settings__dim">{DESK_PHONE_ABSENT_TEXT}</p>
      )}
      {status !== null && alertHints(status).map((hint) => (
        <p key={hint.text} className="ba-settings__line ba-settings__dim">
          {hint.text}
          <button type="button" className="ba-btn ba-btn--ghost ba-btn--quiet" onClick={() => { void runAlertAction(hint.action); }}>
            {HINT_ACTION_LABELS[hint.action]}
          </button>
        </p>
      ))}

      {status !== null && !status.absent && (
        <>
          <label className="ba-switch">
            <input type="checkbox" checked={settings.ringStandby} onChange={(e) => { void toggleStandby(e.target.checked); }} />
            <span>{STANDBY_LABEL}</span>
          </label>
          <p className="ba-settings__line ba-settings__dim">{STANDBY_NOTE}</p>
          {standbyHints(status, settings.ringStandby).map((hint) => (
            <p key={hint.text} className="ba-settings__line ba-settings__dim">
              {hint.text}
              {hint.action !== undefined && (
                <button
                  type="button"
                  className="ba-btn ba-btn--ghost ba-btn--quiet"
                  onClick={() => { void (hint.action === 'battery' ? requestBatteryUnrestricted() : openVendorSettings()); }}
                >
                  {HINT_ACTION_LABELS[hint.action]}
                </button>
              )}
            </p>
          ))}
        </>
      )}
      {note !== null && <p className="ba-settings__line ba-settings__dim">{note}</p>}

      {config !== null && (
        <>
          <label className="ba-switch">
            <input type="checkbox" checked={config.enabled} onChange={(e) => { void toggleCalls(e.target.checked); }} />
            <span>有事的时候主动打电话给我</span>
          </label>
          <p className="ba-settings__line ba-settings__dim">
            打电话的是「等你确认」和「运行失败」这两类 —— 它们要你做个决定。
          </p>
          <label className="ba-switch">
            <input type="checkbox" checked={config.done_call === true} onChange={(e) => { void save({ done_call: e.target.checked }); }} />
            <span>{DONE_CALL_LABEL}</span>
          </label>
          <p className="ba-settings__line ba-settings__dim">
            办完一件事、早报例程跑完,默认只发一条通知,你自己点开看;开了这一格才会响铃。
          </p>
          <p className="ba-settings__line">
            {QUIET_LABEL}
            <input
              className="ba-settings__clock"
              type="time"
              aria-label="免打扰开始"
              value={config.quiet_from}
              onChange={(e) => { void save({ quiet_from: e.target.value }); }}
            />
            —
            <input
              className="ba-settings__clock"
              type="time"
              aria-label="免打扰结束"
              value={config.quiet_to}
              onChange={(e) => { void save({ quiet_to: e.target.value }); }}
            />
          </p>
          {/* 屏上的话里不许出现「**」这类符号(维护者的硬规矩「不露内部的东西」)。 */}
          <p className="ba-settings__line ba-settings__dim">这段时间里照样会有事,只是不出声:不响铃、不念回答、不出提示音。事照办、字照出 —— 电话改发一条通知,第二天早上在「未接来电」里看得到。</p>
        </>
      )}
    </section>
  );
}

/**
 * 「座机」那一组(2026-09-27 之后只剩那只实体话筒):两条配网流程的入口。
 * 两条流程**自己是一整页**(SubPage,带「‹ 返回」,系统返回接得住)——
 * 以前它们原地把这一节换掉,屏上却还写着「设置」,按系统返回直接弹回首页、六步白走。
 * 开哪一页由上一层(SettingsPage)决定,这一节只负责喊一声。
 */
export function HandsetSection({ onAdd, onSwitch }: { onAdd: () => void; onSwitch: () => void }) {
  const presence = useHandsetPresence();
  return (
    <section className="ba-settings__sec">
      {/*
        **座机在不在线**(2026-09-27,卡 RM ①)。维护者 09-27 走完六步、屏上写着「座机已上线」,
        回到这一页却只有一颗「添加座机」—— 他当成「白配了」。现在这一页第一行就说它在不在。
        问不到就整行不出(不写「不在线」:那句话是假的,而它会让他把配好的再配一遍)。
      */}
      {presence.line !== null && <p className="ba-settings__line">{presence.line}</p>}

      {/*
        **附近有没有座机**(2026-09-30,维护者):一打开这一页就扫一遍。座机进不了房时会一直开着蓝牙等人,
        这一行让他当场看见它、点一下就去配 —— 不用先猜「是不是该点添加座机」。
      */}
      <NearbyHandsets onAdd={onAdd} />

      {/*
        实体话筒那一条(2026-09-22,Ben:「整套流程我希望能在客户端里完成」)。
        **排在最前** —— 拿到硬件的人第一件事就是这个。
        已经有一只在线时它退成次要样式:那时这一页的主角是「给座机换网络」。
      */}
      <div className="ba-row">
        <button
          type="button"
          className={presence.hasHandset ? 'ba-btn ba-btn--ghost ba-btn--quiet' : 'ba-btn ba-btn--ghost'}
          onClick={onAdd}
        >
          {ADD_HANDSET_LABEL}
        </button>
      </div>
      <p className="ba-settings__line ba-settings__dim">
        说的是那只实体话筒(拿起听筒接电话的那个)。第一次用要在这儿把家里或办公室的 Wi-Fi 告诉它 ——
        不用切手机的网,也不用插线。
      </p>

      {/*
        换网那一条(2026-09-22 晚,Ben 要用它给派换网)。**和上面那条是两条路**:
        上面那条给**没网**的座机用(蓝牙),这一条给**已经在线**的座机用(走房间)。
      */}
      <div className="ba-row">
        <button type="button" className="ba-btn ba-btn--ghost" onClick={onSwitch}>
          {SWITCH_NETWORK_LABEL}
        </button>
      </div>
      <p className="ba-settings__line ba-settings__dim">{SWITCH_NETWORK_HINT}</p>
    </section>
  );
}
