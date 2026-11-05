/**
 * 未接来电(2026-09-21)。他回到前台时最上面那一张卡。
 *
 * 为什么**不重拨**、而是在这儿列出来(server/callOut.ts 第 4 条规矩):
 * 重拨要么是打扰,要么是在赌他这会儿方便接 —— 两样都不该由代码替他决定。
 * 所以这一张卡的全部职责是:**把他错过的说清楚,并让回拨只要点一下**。
 *
 * 「回拨」= 让工作台再排一通(`POST /call/out`),工人那边照常响铃。
 * **不是**手机自己拨一通普通电话:那样她就不知道这通电话是为哪件事打的了。
 *
 * ## 那颗键什么时候不给(2026-09-22)
 *
 * 服务端对两种回拨是**必拒**的(workbench-plugin/src/server/callOut.ts 的 `request()`):
 * ①「完成」那一类而 `done_call` 关着;② 这一件还有一通没收场。两种手机这边都看得出来
 * (`canCallBack` / `hasLiveCall`,判据与服务端逐条相同),于是:
 *
 *   ① 那几行**不给键**,改一行小字说清「只发通知」和去哪儿开;
 *   ② 那颗键变灰,直到那一通收场。
 *
 * 真被拒了(判漏了、或者服务端另有理由),**那句原话摆在那一行上** —— 整屏一句的话,
 * 三行未接里到底哪一行被拒了他看不出来。
 *
 * ## 2026-09-22 真机(0.2.56)那两件事
 *
 * 1. **收得掉**:顶上那颗从「知道了」换成「清空」。老的那颗只把这一屏藏起来
 *    (下次开 App 九条又回来了),新的这颗发 `POST /call/missed/clear` ——
 *    服务端给那几条记一个 `dismissed_at`,**台账一条不删**。按下去**当场收起**,
 *    不等那一趟回来;台账变了(又来一通)这张卡自己回来(`missedIdsKey`)。
 * 2. **同一件事折叠成一行**:「下班例程 · 未接 7 次 · 最近 17:06」,点「明细」才展开。
 *    回拨 / 给不给键 / 点不点得动**全按最近那一通算** —— 回拨要的是「再打一次这件事」,
 *    哪一通没接到不重要。
 *
 * ## 2026-09-22 真机(0.2.56 / 0.2.57):「横屏展示台没了」
 *
 * 这张卡在舞台页最上面、**在文档流里**(App.tsx 的 `.ba-pane--stage` 里先它、后 `StagePage`),
 * 而舞台 `.ba-scene` 是 `height: 100%`:横屏只有 393px 高,这张卡吃掉多少,
 * 展示台就被顶下去多少 —— 底下那条(通话键 + 输入框)直接出了屏幕。
 *
 * 于是横屏下这张卡**整个不进文档流**:绝对定位压在舞台上方的一条薄横条
 * (规则在 `styles.css` 的 `.ba-missed` 那一段末尾)。这儿多出来的只有
 * **一颗「展开 / 收起」** —— 薄横条上总要有一条路看到那几行。
 * **横竖同一份 DOM**:这颗键竖屏下也在 DOM 里,藏它的是 CSS
 * (同 `.ba-scene__capstoggle` 的做法,见交接-0922-手机横屏收尾第一节)。
 *
 * **清空与折叠一个字没动** —— 那两件是上一张卡刚做的,这一次只动摆放。
 */
import { useState } from 'react';
import {
  CALL_BACK_DONE_OFF_TEXT,
  RING_REASON_TITLES,
  callTimeText,
  canCallBack,
  hasLiveCall,
  missedGroupSummary,
  missedIdsKey,
  missedLatestText,
  missedSayText,
  missedShownGroups,
  type CallLogEntry,
  type CallLogView,
} from './incomingModel';

export interface MissedCallsProps {
  log: CallLogView;
  onCallBack: (entry: CallLogEntry) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 「清空」:告诉工作台这几条他看过了(`POST /call/missed/clear`)。
   * **只标记不删** —— 台账那本记的是发生过的事,读没读过是另一回事。
   */
  onClear: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 首页球下面那一行(2026-09-25 晚,卡 fix/phone-home-card-fit;统筹小米真机:这张卡在球上面、长标题撑出屏幕、
   * 球被挤到右边只露半个)。**收成一行**「未接来电 N · 最近:…」,点一下才铺开那几行(回拨 / 清空 / 明细照旧)。
   * 不给就是原来那张整卡(横屏展示台上那条薄横条用的就是它)。
   */
  compact?: boolean;
  /**
   * 这几件事已经收场了(取消了 / 办完了):**它们引起的未接不再挂在首页**(统筹:「已取消的事项引起的未接来电
   * 不该再显眼地挂着」)。台账一条不删,清空照旧清全部。
   */
  hideItems?: ReadonlySet<string>;
  /**
   * 「收起」那一下交给外面(2026-10-03,卡「首页侧边小图标」)。
   *
   * 首页上**收起来的那一行已经换成侧边那颗小图标**了(维护者:「未接来电和各家的最近对话换个地方放,
   * 做成小图标放到侧边吧」)—— 于是这一块只在她点了那颗图标之后才挂上来,**一挂上来就是铺开的**
   * (那颗图标就是收起来的样子,再先给她一行「未接来电 N ›」等于多一次点),点「收起」= 把它整个卸掉。
   *
   * 不给这一格 = 原来那套它自己管开合(横屏压在展示台上那条薄横条还在用)。
   */
  onClose?: () => void;
}

/** 首页那一行点开之后「收起」那颗。 */
export const MISSED_FOLD_LABEL = '收起';

export const CALL_BACK_LABEL = '回拨';
export const MISSED_CLEAR_LABEL = '清空';
/** 折叠那一行上的「明细」。**不叫「展开」** —— 一米开外读的是「里面都有什么」。 */
export const MISSED_MORE_LABEL = '明细';
export const MISSED_LESS_LABEL = '收起明细';
/**
 * 横屏那条薄横条上的「展开 / 收起」(2026-09-22)。
 * **和上面那对「明细 / 收起明细」不是一回事**:那一对是某一件事的每一通,
 * 这一对是整张卡铺不铺下来。竖屏下这颗键由 CSS 藏起来(竖屏本来就铺着)。
 */
export const MISSED_OPEN_LABEL = '展开';
export const MISSED_CLOSE_LABEL = '收起';

export function MissedCalls({ log, onCallBack, onClear, compact = false, hideItems, onClose }: MissedCallsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  /** 每一行自己的那句原话(服务端拒绝时)。**按组分开**,不是整屏一句。 */
  const [said, setSaid] = useState<Record<string, string>>({});
  /** 展开了明细的那几组。 */
  const [open, setOpen] = useState<readonly string[]>([]);
  /**
   * 按「清空」那一下收起的是**哪一批**未接。存指纹而不是一个布尔:
   * 台账一变(清掉了 / 又来一通)这张卡就该自己回来。
   */
  const [clearedKey, setClearedKey] = useState<string | null>(null);
  /**
   * 横屏那条薄横条铺没铺下来。**默认没铺**:横屏一共 393px 高,
   * 一进来就盖掉半屏展示台正是这张卡要修的那个毛病。竖屏下这个状态不参与任何事
   * (那几行照常铺着,藏的是那颗按钮)。
   */
  const [barOpen, setBarOpen] = useState(false);
  /** 首页那一行(`compact`)点开没有。默认收着:它在球下面,铺开就是在跟球抢地方。 */
  const [lineOpen, setLineOpen] = useState(false);

  /**
   * 开合由外面管(首页侧边那颗图标就是收起来的样子):这时候**不画那一行**,一挂上来就是铺开的。
   * 2026-10-03,卡「首页侧边小图标」;见 `onClose` 那一段。
   */
  const sheet = onClose !== undefined;
  // 已经收场的事引起的未接不挂出来(`hideItems`);没挂在事项上的(item_id 为空)照旧。
  // **这一句与侧边那颗图标的角标数出自同一处**(`missedShownGroups`):两处各数一遍就会不一致。
  const groups = missedShownGroups(log, hideItems);
  const idsKey = missedIdsKey(log);
  if (groups.length === 0 || clearedKey === idsKey) return null;
  /** 挂出来的这几通。首页那一行写它(藏掉的不算);整卡照旧写服务端那个总数(手机只拿到最近几十条)。 */
  const shown = groups.reduce((sum, group) => sum + group.count, 0);

  if (compact && !sheet && !lineOpen) {
    const latest = groups[0]!;
    return (
      <section className="ba-missed" data-compact="true" data-open="false" aria-label="未接来电">
        <button type="button" className="ba-missed__line" aria-expanded={false} onClick={() => setLineOpen(true)}>
          <span className="ba-missed__title">未接来电 {shown}</span>
          <span className="ba-missed__latest">{missedLatestText(latest)}</span>
          <span className="ba-missed__chev" aria-hidden="true">›</span>
        </button>
      </section>
    );
  }

  return (
    /*
      `data-open` 只在横屏下有用:CSS 靠它决定这条薄横条铺不铺下来
      (`styles.css` 里 `@media (orientation: landscape)` 那一段)。
      竖屏下没有任何一条规则读它 —— 那几行本来就铺着。
    */
    <section className="ba-missed" data-open={compact ? true : barOpen} {...(compact ? { 'data-compact': 'true' } : {})} aria-label="未接来电">
      <header className="ba-missed__head">
        {/* 数字用服务端那个 missed(整本台账的),不是这几行的条数 —— 手机只拿到最近几十条。首页那一行点开后写挂出来的那几通。 */}
        <h2 className="ba-missed__title">未接来电 {compact ? shown : log.missed}</h2>
        <button
          type="button"
          className="ba-missed__dismiss"
          onClick={() => {
            // **当场收起**:他按的那一下要立刻有反应,不等网上那一趟。
            // 发不出去时 useIncoming 会在整屏那句 note 里如实说一句(界面上不装作收掉了)。
            setClearedKey(idsKey);
            void onClear();
          }}
        >{MISSED_CLEAR_LABEL}</button>
        {/*
          横屏那条薄横条上的「展开 / 收起」。**永远在 DOM 里**,竖屏下由 CSS 藏
          (`.ba-missed__bar { display: none }`)—— 组件不读屏幕尺寸,这是这一页的纪律。
        */}
        {compact
          ? <button type="button" className="ba-missed__fold" aria-expanded onClick={() => (sheet ? onClose() : setLineOpen(false))}>{MISSED_FOLD_LABEL}</button>
          : (
            <button
              type="button"
              className="ba-missed__bar"
              aria-expanded={barOpen}
              onClick={() => setBarOpen(previous => !previous)}
            >{barOpen ? MISSED_CLOSE_LABEL : MISSED_OPEN_LABEL}</button>
          )}
      </header>
      <ul className="ba-missed__list">
        {groups.map((group) => {
          const entry = group.latest;
          const expanded = open.includes(group.key);
          return (
            <li key={group.key} className="ba-missed__row">
              <div className="ba-missed__what">
                <span className="ba-missed__reason" data-reason={group.reason}>{RING_REASON_TITLES[group.reason]}</span>
                <span className="ba-missed__name">{group.title}</span>
                {/* 一通就写时刻,多通写「未接 7 次 · 最近 17:06」;时刻读不出来就整个不显示。 */}
                {missedGroupSummary(group) !== '' && <span className="ba-missed__at">{missedGroupSummary(group)}</span>}
                {group.count > 1 && (
                  <button
                    type="button"
                    className="ba-missed__more"
                    aria-expanded={expanded}
                    onClick={() => setOpen(previous => (expanded ? previous.filter(one => one !== group.key) : [...previous, group.key]))}
                  >{expanded ? MISSED_LESS_LABEL : MISSED_MORE_LABEL}</button>
                )}
              </div>
              {/*
                「回话来了」那一类:**把那边回的原话留在这一行下面**(2026-09-27,卡 CB)。
                他没接那通电话,这一句就是他唯一看得到回话的地方 —— 电话挂了,字还在。
              */}
              {missedSayText(entry) !== null && <p className="ba-missed__say">{missedSayText(entry)}</p>}
              {canCallBack(log, entry)
                ? (
                  <button
                    type="button"
                    className="ba-missed__back"
                    // 还有一通没收场时点不动 —— 点了也是被拒(服务端同一条判据)。
                    disabled={busy === group.key || hasLiveCall(log, entry)}
                    onClick={() => {
                      setBusy(group.key);
                      setSaid((previous) => { const next = { ...previous }; delete next[group.key]; return next; });
                      // **按最近那一通回拨**:同一件事的同一个理由,排出来的是同一通电话。
                      void onCallBack(entry).then((result) => {
                        setBusy(null);
                        // 没排上就把原话摆在**这一行**上 —— 按了没反应是最气人的一种失败。
                        if (!result.ok) setSaid((previous) => ({ ...previous, [group.key]: result.error }));
                      });
                    }}
                  >
                    {busy === group.key ? '排上了…' : CALL_BACK_LABEL}
                  </button>
                )
                : <span className="ba-missed__only">{CALL_BACK_DONE_OFF_TEXT}</span>}
              {said[group.key] !== undefined && <p className="ba-missed__error">{said[group.key]}</p>}
              {expanded && (
                <ul className="ba-missed__detail">
                  {group.entries.map(one => (
                    <li key={one.id}>
                      <span className="ba-missed__detailat">{callTimeText(one.at) === '' ? '时刻不详' : callTimeText(one.at)}</span>
                      {/* 「响了 60 秒没人接」一类的原话,台账上有就照抄,没有就不编。 */}
                      {one.error !== undefined && <span className="ba-missed__detailsaid">{one.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
