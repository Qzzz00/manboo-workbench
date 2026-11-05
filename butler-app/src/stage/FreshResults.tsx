/**
 * ★ **「刚办完 · 结果一句话」那一条**(2026-10-04,卡 `claude/answer-comes-to-her`)。
 *
 * 维护者 10-04(经工作台捎话):「我刚给事务官发信息,好消息是信息准确,回复也很快,
 * 坏消息是信息直接从正在办切到办完了,我是自己追过去点开查看的……这个交互你得想想咋整」。
 *
 * 她点头的第 2 条:**交代一件事照旧是事项,但办完的结果先摆到她面前** ——
 * 办完不直接沉进「办完」,首页先挂这一条,她**点开看过**或者**划掉**,才收进「办完」。
 *
 * 三条边界:
 * - 摆哪几条**工作台一处算**(`/state.fresh_results`,判据在 `src/answerCell.ts`),这一层只渲染;
 * - 「看过 / 划掉」是**同一件事实**(她看过了),所以只有一条路:`POST /task/seen-result`,
 *   服务端只有一格 `seen_result_at` —— 手机划掉,电脑那张卡下一拍快照就跟着收(**两端同步**);
 * - 摆在两张卡**上面**、球那一栏下面:它是「看一眼就没了」的东西,不该挤掉常驻的那两张卡。
 *   通话中 / 引导中整条不画(同「通话中不放别的出口」那条)。
 *
 * 样式借现成的卡片那一套(`stageCards.css` 的 `ba-cards__*`),**一个新前缀都没加** ——
 * 它就是一张卡的样子,只多两颗键。
 */
import './stageCards.css';
import './freshResults.css';

export interface FreshResultRow {
  id: string;
  text: string;
  note?: string;
}

export function FreshResults({ rows, busy, onOpen, onSeen }: {
  rows: readonly FreshResultRow[];
  /** 这会儿正在标「看过了」的那一张(那一下在路上,两颗键先停住,免得她连点两下)。 */
  busy?: string;
  /** 点开那一件(去事项页那一张)。点开**就算看过了** —— 她已经看到结果了。 */
  onOpen: (taskId: string) => void;
  /** 「划掉」:不点开也算看过了(她扫一眼标题就够了,这很常见)。 */
  onSeen: (taskId: string) => void;
}): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section className="ba-fresh" aria-label="刚办完">
      <h3 className="ba-fresh__title">
        刚办完
        {/* 数就是行数(这一条不折行、不收在「还有 N 件」后面:工作台那一侧已经封了顶)。 */}
        <span className="ba-fresh__count">{rows.length}</span>
      </h3>
      <ul className="ba-fresh__list">
        {rows.map((row) => (
          <li key={row.id} className="ba-fresh__row">
            {/*
              整行点下去 = 打开那一件 + 标看过。写成 button 而不是整行一个 onClick:
              读屏念得出「按钮」,键盘也按得到(同 `ba-cards__linetap` 那一处的理由)。
            */}
            <button
              type="button"
              className="ba-fresh__open"
              disabled={busy === row.id}
              onClick={() => onOpen(row.id)}
            >
              <span className="ba-fresh__text">{row.text}</span>
              {row.note !== undefined && <span className="ba-fresh__note">{row.note}</span>}
            </button>
            {/*
              「划掉」:她扫一眼就够了的那几件。**不是删卡** —— 卡、对话、交付物一个字都没动
              (不可改清单第 5 条:系统不许替她扔东西),收掉的只是「摆在她面前」这一下。
              所以字是「划掉」而不是「删除」,`aria-label` 里说清划的是什么。
            */}
            <button
              type="button"
              className="ba-fresh__dismiss"
              disabled={busy === row.id}
              aria-label={`划掉「${row.note ?? row.text}」这一条(卡还在「办完」里)`}
              onClick={() => onSeen(row.id)}
            >
              划掉
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
