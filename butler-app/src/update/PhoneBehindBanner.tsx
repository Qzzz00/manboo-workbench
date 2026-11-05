/**
 * 首页最顶上那一句「电脑上的事务官更新了,手机端也更新一下」(2026-10-09,卡「四件小事」第 1 件)。
 *
 * 电脑这一版有手机才显示的新格(要文件、答案来找她、它学到了什么、会议待传箱……),
 * 而这台手机包比那一格的起始版本旧时说;判据在 `phoneUpdate.phoneBehind`(只用数得出来的版本号)。
 * 一颗键就是设置里那颗「下载并安装」(同一个 usePhoneUpdate),不跳设置页。
 * 「稍后」只收这一次(下一次打开 App 还在 —— 落后是事实,不该一点就永远不说)。
 */
import { useState } from 'react';
import { PHONE_BEHIND_TEXT, phoneBehind, type PhoneApkState } from './phoneUpdate';
import { PHONE_UPDATE_HANDED_OVER_TEXT, usePhoneUpdate } from './PhoneUpdateSection';
import type { ApkUpdateNative } from './apkUpdater';

export function PhoneBehindBanner({ state, native, fetchImpl }: {
  state: PhoneApkState;
  native?: ApkUpdateNative | null;
  fetchImpl?: typeof fetch;
}) {
  const update = usePhoneUpdate({
    state, ...(native === undefined ? {} : { native }), ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const [later, setLater] = useState(false);
  const behind = phoneBehind({
    ...(state.phone_cells === undefined ? {} : { cells: state.phone_cells }),
    ...(update.mine === undefined ? {} : { mine: update.mine }),
    ...(update.offer === undefined ? {} : { offer: update.offer }),
  });
  if ((behind === undefined && !update.handedOver) || later) return null;

  return (
    <div className="ba-banner ba-banner--wrap" role="region" aria-label="手机端更新">
      <button type="button" className="ba-banner__main" disabled={update.busy} onClick={update.start}
        title={behind === undefined ? undefined : `新的:${behind.missing.join('、')}`}>
        <span>{PHONE_BEHIND_TEXT}</span>
        {' · '}
        <span>{update.busy ? (update.progress ?? '正在下…') : '一键更新'}</span>
      </button>
      {!update.busy && <button type="button" className="ba-banner__later" onClick={() => setLater(true)}>稍后</button>}
      {update.handedOver && <p className="ba-banner__note">{PHONE_UPDATE_HANDED_OVER_TEXT}</p>}
      {update.failed !== undefined && <p className="ba-banner__note">{update.failed}</p>}
      {update.needPermission && (
        <button type="button" className="ba-banner__later" onClick={update.openPermission}>去系统设置里允许</button>
      )}
    </div>
  );
}
