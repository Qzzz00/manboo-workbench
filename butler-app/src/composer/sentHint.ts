/**
 * 「已送到 · 10:38」—— **送到了才有**的那一行(2026-10-03,卡 claude/phone-saybox-pinned)。
 *
 * 维护者 10-03 上午从手机捎来:「发送成功最好给个小提示,显示发送成功。」
 * 原来两种会话页按下发送后,成功那一下的回执她都看不见:
 *   · 捎话(items/SessionSayBox.tsx)—— 工作台那句话排在整张卡最底下,得先滚过整段对话;
 *   · 替她答(asks/AskCards.tsx 的 PhoneSessionAsk)—— 走首页那颗 `.ba-toast`,可「等你确认」那一页
 *     与它同一档 z-index、又排在它后面,整条提示画在那一页**后面**(asks.css 的 `.ba-asks-page`
 *     是 `background: #000` 的整屏覆盖层)。
 * 所以这一行**摆在输入框自己旁边** —— 输入框 2026-10-03 起吸底、永远在眼前,这一行跟着它。
 *
 * 两条口径:
 *   - **只有真送到才有**:捎话是 `/sessions/relay` 回 `ok:true`,替她答是工作台**核实过**
 *     (`confirmed: true`)。「写进去了,但没看到它收下」不算送到 —— 那一句照旧原样摆出来,
 *     不许画成一句「成功」(D13 那条:不给摆设,也不替工作台说好话)。
 *   - 时刻照**电脑的钟**(`/state.now`,口径见 src/clock.ts):与它上面那段对话里每一句的时刻
 *     同一把尺。还没连上(`now` 是空的)就只写「已送到」,不拿手机的墙钟凑一个数。
 *
 * 这一行是**算出来的**,算完就冻住:会话详情那一页 4 秒一拍地重读 digest,`now` 每拍都新 ——
 * 存字符串(不是存一个 `ok` 再在渲染时取当下的 `now`),否则她打完一句话,那个「已送到」
 * 的点会自己往前走。
 */
import { formatClock } from '../hooks';

/** 送到了那三个字(读屏念的、用例钉的都是它)。 */
export const SENT_OK_TEXT = '已送到';

/** 「已送到 · 10:38」;`now` = `/state.now`(缺席 / 空字符串 / 认不出时只有前三个字)。 */
export function sentOkLine(now: string | undefined): string {
  const clock = now === undefined || now === '' ? '' : formatClock(now, now);
  return clock === '' ? SENT_OK_TEXT : `${SENT_OK_TEXT} · ${clock}`;
}
