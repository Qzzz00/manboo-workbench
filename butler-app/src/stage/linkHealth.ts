/**
 * 首页「电脑认不认这台手机」那一块(2026-09-23 第二轮从零重装)。纯函数,界面是它的投影。
 *
 * 真机那天:电脑整个重装、换了账号,手机还拿着上一台安装的配对。首页写着「电脑不在线」+
 * 「经房间问 Mac 上的事务官,等了很久没人答(电脑上的工人可能没在跑)」,卡片是上一台安装的旧数据 ——
 * 它没意识到要重新配对,维护者只能自己进设置、退出登录、再扫码。
 *
 * 现在通道层进房后几秒内就给出结论(channel.ts `presence()`),这里把结论翻成一句话 + 一颗键:
 *   - `revoked`(中转明说这台手机的令牌不认了)→ **确定**不认:「电脑不认这台手机了」;
 *   - `absent`(进了房、等过、核对过,房里就是没有电脑)→ 先看卡 PH 那一格(这台手机根本找不回
 *     电脑的新房间),再看卡 AW 那段:**按「电脑是怎么走的」分三路**;
 *   - 其余(连着、还不知道、直连能通)→ 不出这一块。
 * 只在**首页没连上**时出:连着就说明电脑认它,房里那点事与首页无关。
 *
 * ——— 2026-09-28,卡 AW:电脑睡了不是配对坏了 ———
 * 维护者的新 Air 不插电时会自己睡,一睡首页就写「找不到你的电脑」+「重新扫码配对」——
 * 那句话说的是配对坏了,而其实只是电脑睡了,她照着做只会白扫一遍。所以 `absent` 再分三路
 * (依据来自 roomLink 的 {@link WbchWorkerDeparture},那边写清了依据与它的边界):
 *   - `timeout`(没说再见就消失了:超时 / 信令断 / 媒体断)→「电脑睡着了」,**不催她重新扫码**
 *     (房间是对的,配对没坏);
 *   - `closed`(**确知**电脑那一方自己退了)→ 工作台没在运行,去电脑上打开它;
 *   - `unknown`(没有依据)→ **保持原来的口径**:两种都说 + 「重新扫码配对」,另外把
 *     「它可能睡着了或没联网」说在前面。**没有依据时一个字都不许说成睡着了。**
 */
import type { WbchPresence } from '../channel/channel';
import type { WbchWorkerDeparture } from '../channel/roomLink';

export const RELINK_ACTION_LABEL = '重新扫码配对';

export const RELINK_REVOKED_TITLE = '电脑不认这台手机了';
export const RELINK_REVOKED_DETAIL = '电脑重装过、换了账号,或者在电脑上移除了这台手机。重新扫一次电脑上的二维码就好。';

export const RELINK_ABSENT_TITLE = '连不上你的电脑';
export const RELINK_ABSENT_DETAIL = '它可能睡着了或没联网。电脑关着的话,开机后会自己连上。电脑重装过或换了账号的话,它已经不认这台手机了,要重新扫码配对。';

/** 确知电脑是「没说再见就消失了」那一路(2026-09-28,卡 AW)。 */
export const RELINK_ASLEEP_TITLE = '电脑睡着了';
export const RELINK_ASLEEP_DETAIL = '合盖或省电睡过去了,打开电脑就会自己连上。';

/** 确知电脑那一方自己退了那一路(2026-09-28,卡 AW)。 */
export const RELINK_QUIT_TITLE = '电脑上的工作台没在运行';
export const RELINK_QUIT_DETAIL = '电脑是醒着的,上面的工作台退出了。在电脑上打开工作台就会自己连上。';

/**
 * **这台手机没有挂在账号下的设备令牌**那一路(2026-09-28,卡 PH)。
 *
 * 电脑升级后带账号重领了机器令牌、搬进账号那间房;有账号令牌的手机会自己向中转要新房间的
 * 凭证跟过去,**没有的那一台**(老的纯扫码配对)连「新房间叫什么」都问不到 —— 它只能重新扫一次码。
 * 这一路**压在 departure 前面**:那时电脑那一方往往是「自己退了」(它离开了旧房间),
 * 照 departure 说就成了「电脑上的工作台没在运行」—— 而电脑好好的,那句话是错的。
 */
export const RELINK_NO_ACCOUNT_TITLE = '电脑换了连接方式';
export const RELINK_NO_ACCOUNT_DETAIL = '电脑更新后换了连接方式,这台手机找不到它的新房间了。在电脑上打开配对二维码,重新扫一次就好 —— 事项和记录都不会丢。';

export interface RelinkNotice {
  kind: 'revoked' | 'absent' | 'asleep' | 'quit' | 'no_account';
  title: string;
  detail: string;
  /**
   * 那颗键。**只有「重新扫码配对」真的是下一步时才有**(2026-09-28,卡 AW):
   * 电脑睡着了 / 工作台没开着的时候房间是对的,让她重新扫码是把人带错路。缺席就是不画键。
   */
  action?: string;
}

/**
 * `presence` 只要那个 kind(界面按字符串订阅,快照稳定);`departure` 同理,是个字符串。
 * `departure` 不给 = 没有依据(老调用方 / 老的假通道层)→ 走 `unknown` 那一路。
 */
export function relinkNotice(input: {
  connected: boolean;
  presence: WbchPresence['kind'] | undefined;
  departure?: WbchWorkerDeparture | undefined;
  /**
   * 核对房间的结论(2026-09-28,卡 PH)。只认 `no_account` 那一格 ——
   * 其余的(same / unknown / moved)照旧由 `departure` 说了算。不给就当没核对过。
   */
  check?: 'same' | 'unknown' | 'moved' | 'no_account' | undefined;
}): RelinkNotice | null {
  if (input.connected || input.presence === undefined) return null;
  if (input.presence === 'revoked') {
    return { kind: 'revoked', title: RELINK_REVOKED_TITLE, detail: RELINK_REVOKED_DETAIL, action: RELINK_ACTION_LABEL };
  }
  if (input.presence === 'absent') {
    // **压在 departure 前面**(卡 PH):这台手机自己找不回账号那间房,电脑却可能好好的 ——
    // 照 departure 说会说成「工作台没在运行」,那是错的。这一路给「重新扫码配对」。
    if (input.check === 'no_account') {
      return { kind: 'no_account', title: RELINK_NO_ACCOUNT_TITLE, detail: RELINK_NO_ACCOUNT_DETAIL, action: RELINK_ACTION_LABEL };
    }
    // 确知睡过去了 / 确知工作台自己退了:说那一件事,不给「重新扫码配对」。
    if (input.departure === 'timeout') return { kind: 'asleep', title: RELINK_ASLEEP_TITLE, detail: RELINK_ASLEEP_DETAIL };
    if (input.departure === 'closed') return { kind: 'quit', title: RELINK_QUIT_TITLE, detail: RELINK_QUIT_DETAIL };
    // 没有依据:原来那套口径一个字没动,键照给。
    return { kind: 'absent', title: RELINK_ABSENT_TITLE, detail: RELINK_ABSENT_DETAIL, action: RELINK_ACTION_LABEL };
  }
  return null;
}

/**
 * 卡片区此刻怎么摆(2026-09-23)。没连上时卡片上是**上次拿到的**数据 —— 真机那天那是上一台安装的,
 * 一眼看上去和「现在的事」没有区别。所以:
 *   - 连着 → `live`,照常;
 *   - 没连上、以前拿到过(`state.now` 不空)→ `stale`:**收起**,只留一行「上次的数据」,点开才看,看的时候也标着;
 *   - 没连上、一次都没拿到过 → `none`:不画(空卡片会说「没有事项」,那是没问到,不是没有)。
 */
export type CardsView = 'live' | 'stale' | 'none';
export function cardsViewOf(input: { connected: boolean; now: string }): CardsView {
  if (input.connected) return 'live';
  return input.now === '' ? 'none' : 'stale';
}

/** 「上次的数据」那一行。`at` 是那份快照自己的时刻(/state.now),读不懂就不写时刻。 */
export function staleCardsLabel(at: string, open: boolean): string {
  const d = new Date(at);
  const when = Number.isNaN(d.getTime())
    ? ''
    : ` · ${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `上次的数据(电脑没连上)${when}${open ? ' · 收起' : ' · 展开'}`;
}
