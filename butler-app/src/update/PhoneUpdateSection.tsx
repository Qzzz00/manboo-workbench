/**
 * 设置 → 关于与更新 里「手机包」那一节(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 维护者原话(装了 0.4.90 手机包之后):
 * 「手机端现在每次更新我都得跳转官网去下载,而且包也没有版本号……」
 *
 * 09-28 卡 UP 定的那条规矩**没改**:一节、一个动作。换的只是那个动作 ——
 * 从「打开官网」变成「下载并安装」,下载与校验在 App 里做完,最后交给系统安装器。
 * 官网降成最后一行小字:下不动时她还有退路,但不再是唯一的路。
 *
 * 屏上**不出现 apk 直链**(09-28 那条还在:直链会过期),也不出现校验码。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OFFICIAL_SITE,
  PHONE_UPDATE_PERMISSION_TEXT,
  localPhoneVersion,
  phoneDownloadProgressText,
  phoneUpdateVerdict,
  pickPhoneApk,
  type PhoneApkState,
} from './phoneUpdate';
import { apkUpdateNative, downloadAndInstall, readApkInfo, type ApkUpdateNative } from './apkUpdater';
import { usePhoneBuildStamp } from './buildStamp';

/** 交出去之后那一句:剩下的几步是系统的事,App 替不了(也不该替)。 */
export const PHONE_UPDATE_HANDED_OVER_TEXT = '已经交给系统安装器了,照屏上的提示装一遍。装完 App 会重开一次,登录不用重来。';

/**
 * 手机包那一下的全部状态与动作:本机装的哪一版、该不该更新、按下去下载 / 核校验码 / 交给系统安装器。
 * 设置里那一节与首页「手机端也更新一下」那一句(PhoneBehindBanner)共用,两处的门槛与动作一样。
 */
export function usePhoneUpdate({ state, native, fetchImpl }: {
  state: PhoneApkState;
  native?: ApkUpdateNative | null;
  fetchImpl?: typeof fetch;
}) {
  const impl = useMemo(() => (native === undefined ? apkUpdateNative() : native), [native]);
  const stamp = usePhoneBuildStamp(fetchImpl);
  const [nativeVersion, setNativeVersion] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void readApkInfo(impl).then((info) => {
      if (alive && typeof info?.versionName === 'string') setNativeVersion(info.versionName);
    });
    return () => { alive = false; };
  }, [impl]);

  const [busy, setBusy] = useState(false);
  /** 下到哪儿了(进度事件来了才有)。 */
  const [progress, setProgress] = useState<string | undefined>(undefined);
  /** 没装上时那一句,照实说。 */
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [needPermission, setNeedPermission] = useState(false);
  const [handedOver, setHandedOver] = useState(false);

  const offer = pickPhoneApk(state);
  const mine = localPhoneVersion({
    ...(nativeVersion === undefined ? {} : { native: nativeVersion }),
    ...(stamp?.version === undefined ? {} : { stamp: stamp.version }),
  });
  const verdict = phoneUpdateVerdict({
    ...(offer === undefined ? {} : { offer }),
    ...(mine === undefined ? {} : { mine }),
  });

  const start = useCallback(() => {
    if (offer === undefined || busy) return;
    setBusy(true);
    setFailed(undefined);
    setNeedPermission(false);
    setHandedOver(false);
    setProgress(undefined);
    void downloadAndInstall({
      native: impl,
      offer,
      onProgress: (received, total) => setProgress(phoneDownloadProgressText(received, total)),
    }).then((outcome) => {
      setBusy(false);
      setProgress(undefined);
      if (outcome.ok) { setHandedOver(true); return; }
      setFailed(outcome.error);
      setNeedPermission(outcome.needPermission === true);
    });
  }, [impl, offer, busy]);

  const openPermission = useCallback(() => {
    void (async () => {
      try { await impl?.openInstallPermission(); }
      catch { setFailed('打不开系统那一页 —— 自己进:系统设置 → 应用 → 事务官 → 安装未知应用。'); }
    })();
  }, [impl]);

  return { offer, mine, verdict, start, openPermission, busy, progress, failed, needPermission, handedOver };
}

export function PhoneUpdateSection({ state, native, fetchImpl }: {
  /** `/state` 里那两格(电脑上那份清单里的手机包)。 */
  state: PhoneApkState;
  /** 测试注入;`null` = 这台设备上没有原生那条路。不传 = 真机上那一件。 */
  native?: ApkUpdateNative | null;
  /** 测试注入(读 build.json 那一下)。 */
  fetchImpl?: typeof fetch;
}) {
  const { verdict, start, openPermission, busy, progress, failed, needPermission, handedOver } = usePhoneUpdate({
    state, ...(native === undefined ? {} : { native }), ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  // 电脑没查过清单、或者这一版压根没带手机包:整节不出现(不编一个「已经是最新」)。
  if (verdict.kind === 'none') return null;
  const action = 'action' in verdict ? verdict.action : undefined;

  return (
    <section className="ba-settings__sec">
      <h2 className="ba-inbox__h">{verdict.title}</h2>
      <p className="ba-settings__line">{verdict.detail}</p>
      {action !== undefined && (
        <>
          <div className="ba-row">
            <button type="button" className="ba-btn" disabled={busy} onClick={start}>
              {busy ? (progress ?? '正在下…') : action}
            </button>
          </div>
          <p className="ba-settings__line ba-settings__dim">{PHONE_UPDATE_PERMISSION_TEXT}</p>
        </>
      )}
      {handedOver && <p className="ba-settings__line">{PHONE_UPDATE_HANDED_OVER_TEXT}</p>}
      {failed !== undefined && <p className="ba-settings__line ba-settings__dim">{failed}</p>}
      {needPermission && (
        <div className="ba-row">
          <button type="button" className="ba-btn ba-btn--ghost" onClick={openPermission}>去系统设置里允许</button>
        </div>
      )}
      {/* 官网那条退路:一行小字,不是按钮(2026-10-03 把它从唯一的路降成退路)。 */}
      <p className="ba-settings__line ba-settings__dim">
        实在下不动,也可以去官网下一份:
        <a href={`https://${OFFICIAL_SITE}`} target="_blank" rel="noreferrer">{OFFICIAL_SITE}</a>
      </p>
    </section>
  );
}
