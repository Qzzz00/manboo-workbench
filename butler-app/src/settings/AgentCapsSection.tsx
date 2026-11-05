/**
 * 手机设置里「各家能做什么」(2026-09-25,卡 O):与电脑设置那张表同一份(`/state.agent_caps`),**只读**。
 * 修法(「登录 Claude」)都要在电脑前做 —— 手机上只说一句,不画按钮(按了也够不着那台 Mac 的屏幕)。
 */
import type { AgentCapsView, AgentQuotaView, CapCellView, WorkbenchState } from '../api/protocol';
// 各家的 logo(2026-09-26,卡 LG3):这一页一家一行 —— 名字前那张图,与额度那一句同一行。
import { AgentIcon } from '../agents/AgentIcon';

const CELLS: readonly { key: 'chat' | 'edit' | 'collect'; title: string }[] = [
  { key: 'chat', title: '能聊天' },
  { key: 'edit', title: '能改本机文件' },
  { key: 'collect', title: '能收回结果' },
];

function mark(cell: CapCellView): string {
  if (cell.state === 'ok') return '行';
  if (cell.state === 'no') return '不行';
  if (cell.state === 'na') return '没有';
  return '没查到';
}

/**
 * 额度那一句(三格之一:有数照原话、「不限」、「没接上:原因」)。
 *
 * 2026-09-26(卡 QS):**有数就照原话摆** —— 工作台那一句里已经带着「昨晚 20:42 读到的」
 * 与「Claude 桌面没在跑,数字可能旧」,电脑与手机一个字不差。这里不另写一套说法。
 *
 * 2026-10-02(卡 QK):过线那一句里现在还带着**为什么读不到**与**配上什么就能实时**
 * (「…上次 04:27 · Claude 桌面没在跑 · 点一下「接上」就实时」,由各家额度来源自己声明;
 * 2026-10-03 那第二句从「配一把密钥」改成了「点一下接上」—— 电脑上那一步现在真的只有一颗键)。
 * 这里仍然一个字都不改 —— 照念。那颗入口键是「只能在电脑前做」的那一档(`stale_hint.live.fix.desk_only`),
 * 手机上**不画按钮**(同这一页其余的修法)。
 */
export function quotaWords(one: AgentQuotaView | undefined): string | undefined {
  if (one === undefined) return undefined;
  if (one.state === 'unlimited') return '额度不限';
  return `额度${one.state === 'unconnected' ? '' : ':'}${one.line}`;
}

/**
 * 额度那一句下面的**细账**(2026-09-27,卡 AG)。维护者原话:「为什么我肉眼都看到额度信息了,
 * 但是还说读不到或者读反了」——「读到」不只是读到一个数,是**照它页面怎么列就怎么列**。
 *
 * 手机上画不了四条横条(一行就那么宽),所以写成一句:组名一段、组里一行一条,
 * 组名与行名都是从那一页上读回来的**原话**,百分比照原话,口径是剩余:
 *
 * 「Gemini Models:Weekly Limit Remaining 100% · Five Hour Limit Remaining 98%;
 *   Claude and GPT models:Weekly Limit Remaining 100% · Five Hour Limit Remaining 100%」
 *
 * 只有一行的那几家(七家老路子、豆包办公两扇窗)不出这一句 —— 上面 `line` 已经说完了,再写一遍是噪音。
 */
export function quotaRowWords(one: AgentQuotaView | undefined): string | undefined {
  const rows = one?.windows ?? [];
  if (rows.length < 2) return undefined;
  const out: string[] = [];
  let group: string | undefined;
  let bucket: string[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    out.push(group === undefined ? bucket.join(' · ') : `${group}:${bucket.join(' · ')}`);
    bucket = [];
  };
  for (const row of rows) {
    if (row.group !== group) { flush(); group = row.group; }
    bucket.push(`${row.label} ${Math.max(0, Math.min(100, Math.round(row.left_pct)))}%`);
  }
  flush();
  return out.join(';');
}

export function AgentCapsSection({ caps, quotas, agents }: {
  caps?: AgentCapsView;
  quotas?: readonly AgentQuotaView[];
  /** 认那几家用的(卡 LG3:名字前那张 logo)。缺了就没有图,这一页其余一个字不变。 */
  agents?: Pick<WorkbenchState, 'agent_registry'>;
}) {
  if (caps === undefined) return null;
  return (
    <section className="ba-settings__sec" data-testid="agent-caps">
      <h2 className="ba-inbox__h">各家能做什么</h2>
      <p className="ba-settings__line ba-settings__dim">{caps.line}</p>
      {caps.agents.filter((one) => one.installed !== false).map((agent) => {
        const problem = CELLS.map((cell) => agent.cells[cell.key]).find((cell) => cell.state === 'no');
        const view = quotas?.find((one) => one.id === agent.family);
        const quota = quotaWords(view);
        const rows = quotaRowWords(view);
        return (
          <div key={agent.family} className="ba-settings__line">
            {/* 名字前那张 logo(卡 LG3);取不到就是这一家的色点,行里其余一个字不变。 */}
            <AgentIcon agent={agent.family} state={agents} />
            {' '}
            <strong>{agent.title}</strong>
            {' '}
            {[...CELLS.map((cell) => `${cell.title} ${mark(agent.cells[cell.key])}`), ...(quota === undefined ? [] : [quota])].join(' · ')}
            {/* 卡 AG:页面上分几行就照着写几行(Antigravity 的两组四条),上面那句 `line` 不动。 */}
            {rows !== undefined && (
              <span className="ba-settings__dim">
                {' '}（{rows}）
              </span>
            )}
            {problem !== undefined && (
              <span className="ba-settings__dim">
                {' '}—— {problem.note}{problem.fix !== undefined ? `(要在电脑前点「${problem.fix.label}」)` : ''}
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}
