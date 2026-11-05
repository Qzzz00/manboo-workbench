/**
 * 首页球下面的卡片区(2026-09-21 按运营同事白板第三节铺;2026-09-25 重排;2026-10-03 傍晚只剩两张)。
 *
 * 竖版:球在上、球下那一排图标、**两张卡并排各占一半**(正在办 / 等你确认)。
 * 2026-10-03 傍晚维护者看过示意图拍的方案 B:「只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon
 * 就 OK……中间的球球还是要大的,这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。」
 * 另三张(今天要做 / 最近一次通话 / 资讯)搬成那一排里的图标(stage/HomeRail.tsx),内容在各自那一页上;
 * 画哪两张由 stageCardsModel 的 {@link homeCards} 说(它也把「正在办」从整行改成半宽)。
 * 横竖两向用的是**同一份卡片**,差别全在 CSS 里。
 *
 * **整张卡都能点**(2026-09-25,维护者 19:55:以前只能点卡里那颗「去看」,「交互不对」)。
 * 做法是卡片里一颗铺满整张卡的透明按钮(读屏名「打开「<卡名>」」),字照常画在它上面、可读;
 * 右上角一个「›」只是提示这张卡点得开。没有去处的卡不画那颗按钮(点了没反应比不能点更糟,D13)。
 *
 * **行数固定**(2026-09-25 晚,卡 fix/phone-home-card-fit):标题下面固定几行(stageCardsModel.CARD_ROWS),
 * 卡片高度由行数算出来、五张一样高;一行一件、一行之内截断带省略号;件数多于行数时最后一行是「还有 N 件」。
 * 屏矮(或开了大字)时两行 —— 按舞台那一格的高度定(`useCardRows`),不按窗口高度:
 * 弹键盘时窗口被压矮,舞台那一格是钉住的(viewport/keyboardViewport.ts),行数不跟着跳。
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { StageCard, StageCardTarget } from './stageCardsModel';
import { CARD_ROWS, cardRowsFor, homeCards } from './stageCardsModel';
import type { WorkbenchState } from '../api/protocol';
import './stageCards.css';
// 各家的 logo(2026-09-26,卡 LG3):「正在办」「等你确认」里说得清是哪一家的那几行,名字前一张图。
import { AgentIcon, AGENT_ICON_SIZE_SMALL } from '../agents/AgentIcon';
import { FxBeam } from '../fx/Fx';
import { BEAM, stageCardFx, type StageStrong } from '../fx/fxModel';

/**
 * 这一屏放几行:看卡片所在的舞台(`.ba-scene`)有多高、html 的字号多大。
 * 量不到(测试环境没有 ResizeObserver、还没挂上)就是 {@link CARD_ROWS}。
 */
function useCardRows(ref: RefObject<HTMLElement | null>): number {
  const [rows, setRows] = useState(CARD_ROWS);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const scene = el.closest<HTMLElement>('.ba-scene') ?? el.parentElement;
    if (scene === null) return undefined;
    const measure = () => {
      const height = scene.getBoundingClientRect().height;
      // 舞台藏起来(进了设置 / 事项那一页)时量到 0:不算数,留着上一次的行数,回来时不闪一下。
      if (!(height > 0)) return;
      const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setRows(cardRowsFor(height, root));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scene);
    return () => observer.disconnect();
  }, [ref]);
  return rows;
}

export function StageCards({ state, onOpen, onOpenRow, stale, strong = null }: {
  state: WorkbenchState;
  /**
   * 这一屏的强效果归谁(动效配角,见 fx/fxModel.stageStrong)。归「正在办」时它整圈走光;
   * 「等你确认」那块有东西就轻轻呼吸(弱效果,不占名额)。缺省谁都不走光。
   */
  strong?: StageStrong;
  /** 整张卡点下去去哪。不传就不画那颗铺满的按钮(卡片本身照常显示)。 */
  onOpen?: (to: StageCardTarget) => void;
  /**
   * 「等你确认」里**点哪一行开哪一件**(2026-09-28,卡 UX;维护者:首页第一行是「让 Manus…」,
   * 点进去打开的是整列、最上面是另外两条,他照着眼前那张卡批了别的事)。
   * 不传就还是整张卡一个去处(老样子)。
   */
  onOpenRow?: (lineId: string) => void;
  /**
   * 电脑没连上时,卡片上是**上次的数据**(2026-09-23 第二轮从零重装:那天是上一台安装的旧数据,
   * 看上去和现在的事没区别)。给了就收起成一行「上次的数据」,点开才看、看的时候也标着。
   */
  stale?: { label: string; open: boolean; onToggle(): void };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useCardRows(ref);
  const cards = homeCards(state, rows);
  const bar = stale === undefined ? null : (
    <button type="button" className="ba-cards__stalebar" aria-expanded={stale.open} onClick={stale.onToggle}>{stale.label}</button>
  );
  if (stale !== undefined && !stale.open) {
    return <div ref={ref} className="ba-cards ba-cards--stale" data-stale="collapsed">{bar}</div>;
  }
  return (
    <div
      ref={ref}
      className="ba-cards"
      role="list"
      aria-label="首页卡片"
      data-rows={rows}
      {...(stale === undefined ? {} : { 'data-stale': 'open' })}
    >
      {bar}
      {cards.map((card) => {
        // 旧数据(电脑没连上)展开来看的时候不亮:那不是此刻的事。
        const fx = stale === undefined ? stageCardFx({ id: card.id, lines: card.lines.length }, strong) : { beam: null, active: false };
        const section = (
          <Card
            key={card.id}
            card={card}
            state={state}
            {...(onOpen === undefined || stale !== undefined ? {} : { onOpen })}
            {...(onOpenRow === undefined || stale !== undefined ? {} : { onOpenRow })}
          />
        );
        if (fx.beam === null) return section;
        return (
          <FxBeam key={card.id} name={`card-${card.id}`} spec={fx.beam === 'doing' ? BEAM.doingCard : BEAM.confirmCard} active={fx.active}>
            {section}
          </FxBeam>
        );
      })}
    </div>
  );
}

function Card({ card, state, onOpen, onOpenRow }: { card: StageCard; state?: WorkbenchState; onOpen?: (to: StageCardTarget) => void; onOpenRow?: (lineId: string) => void }) {
  const to = card.to;
  const open = to !== undefined && onOpen !== undefined ? () => onOpen(to) : undefined;
  /** 「等你确认」那一张的每一行各自点得开(卡 UX):别的卡还是整张一个去处。 */
  const rowOpen = card.id === 'confirm' ? onOpenRow : undefined;
  /**
   * 附注放哪儿:**占整行的那一张**是右边单独一格(哪一家在办,一直在);「最近一次通话」另起一行;
   * 其余跟在标题后面同一行、前面一个「·」,整行多了省略号 —— 地方不够时先没的是附注(标题优先)。
   *
   * 2026-10-03 傍晚(方案 B)这一格从「是不是『正在办』」改成「**占不占整行**」:
   * 「正在办」现在是半宽(两张卡并排各一半),175px 上那一格会把标题挤成一个省略号 ——
   * 半宽就该走「标题优先」那条老规矩。CSS 那几条同样改挂在 `[data-wide="true"]` 上,一个概念一个开关。
   */
  const noteBeside = card.wide === true;
  return (
    <section
      className="ba-cards__card"
      role="listitem"
      data-card={card.id}
      data-wide={card.wide === true}
      data-stacked={card.stacked === true}
      data-openable={open !== undefined}
      data-empty={card.lines.length === 0}
    >
      {/* 铺满整张卡的那颗按钮:排在最前,字画在它上面、不接点击(stageCards.css 的 pointer-events)。 */}
      {open !== undefined && (
        <button type="button" className="ba-cards__tap" aria-label={`打开「${card.title}」`} onClick={open} />
      )}
      <header className="ba-cards__head">
        <h2 className="ba-cards__title">{card.title}</h2>
        {/* 没有数可数的卡片整个不画这一颗 —— 不画 0(D13)。 */}
        {card.count !== undefined && <span className="ba-cards__count">{card.count}</span>}
        {open !== undefined && <span className="ba-cards__chev" aria-hidden="true">›</span>}
      </header>
      <div className="ba-cards__body">
        {/*
          垫在标题下面、看不见的那 `rows` 行(2026-09-25 夜,卡 fix/phone-home-orb-first):行是 CSS 画的(::before 里几个「国」字,
          按卡片区的 data-rows 几行),这一格的高度就是它按**真字体**排出来的高 —— 不写死像素,换了字体、放大了字都跟着长。
        */}
        <span className="ba-cards__space" aria-hidden="true" />
        {card.lines.length === 0
          ? <p className="ba-cards__empty">{card.empty}</p>
          : (
            <ul className="ba-cards__list">
              {card.lines.map((line) => {
                const icon = line.agent === undefined
                  ? null
                  : <AgentIcon agent={line.agent} state={state} size={AGENT_ICON_SIZE_SMALL} />;
                return (
                <li className="ba-cards__line" key={line.id}>
                  {/*
                    这一行自己那颗按钮(2026-09-28,卡 UX):盖在这一行上、看不见,读屏名就是这一行的话。
                    排在字前面、`pointer-events: auto` 把这一行从「整张卡那颗」手里抢过来 —— 点哪件开哪件。
                  */}
                  {rowOpen !== undefined && (
                    <button type="button" className="ba-cards__linetap" aria-label={`打开「${line.text}」`} onClick={() => rowOpen(line.id)} />
                  )}
                  {/*
                    这一行说的是哪一家:**名字前**那张 logo(卡 LG3)。说不清是哪一家的行(纯事项、事务官问的)什么都不加。
                    图画在**名字所在的那一格里面**,不另占一格:
                      -「正在办」那一张的名字在右边那一格(`.ba-cards__note` 写的就是「Claude · 内含 3 项后台任务」),
                        图进它;另起一格会多吃掉 8px 的 gap,而那一行本来就挤(09-26 真机量到它已经要溢出)。
                      - 其余那几张的名字在 `.ba-cards__text` 里,那一格是块级带省略号的,图也必须画在它里面 ——
                        画在外面会自己占掉一整行。
                  */}
                  {noteBeside || card.stacked === true
                    ? (
                      <>
                        <span className="ba-cards__text">{line.text}</span>
                        {line.note !== undefined && (
                          <span className="ba-cards__note">{icon !== null && <>{icon}{' '}</>}{line.note}</span>
                        )}
                        {line.note === undefined && icon}
                      </>
                    )
                    : (
                      <span className="ba-cards__text">
                        {icon !== null && <>{icon}{' '}</>}
                        {line.text}
                        {line.note !== undefined && <span className="ba-cards__note">{line.note}</span>}
                      </span>
                    )}
                </li>
                );
              })}
              {/* 列出来之外还剩几件:占最后那一行。**一件不剩就整行不出现**,不写「还有 0 件」。 */}
              {card.more !== undefined && <li className="ba-cards__line ba-cards__more">{`还有 ${card.more} 件`}</li>}
            </ul>
          )}
      </div>
    </section>
  );
}
