/**
 * 事务官问你的话、要你批的事 —— 手机「等你确认」点开那一页上的卡(2026-09-25,卡 M;维护者点名的 bug)。
 *
 * 维护者:「对于用户来说,不应该漏出来这个底层,选项应该直接在外层事务官那里显示」;他在外面只拿手机时,
 * 以前那个「派活前对一遍」只在电脑上 DSH 的原始界面里有,答不了。现在:
 *   - 她的话 + 选项(点一个就交)+ 「我自己说」;
 *   - 要批的那件事说人话(要做什么、为什么、放开到多大),「允许这一次 / 这件事里同类的都允许 / 不行」;
 *   - 哪边先答算哪边:电脑上答了,这里跟着消失。
 * 与电脑 workbench-plugin/src/client/QuestionAsk.tsx、ApprovalAsk.tsx 同一件事(两个仓库目录互不 import,各写一份)。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { AskSessionView, PendingApprovalView, PendingQuestionView, QuestionAnswerItem, SessionApprovalKey, SessionView, WorkbenchState } from '../api/protocol';
// 那一家叫什么**先问主人**(登记表):窗口型那几家的名字只有那儿有(2026-10-03,审计第四节第 2 条)。
import { registryAgentName } from '../api/protocol';
import { askSubject, dispatchApprovalFace } from './asksModel';
// 各家的 logo(2026-09-26,卡 LG3):派活确认点那几家一家一行、「X 在等你选」那一句的抬头。
import { AgentIcon, AGENT_ICON_SIZE_SMALL } from '../agents/AgentIcon';
// 「已送到 · 10:38」(2026-10-03,卡 claude/phone-saybox-pinned):送到了才有,口径见那一份的文件头。
import { sentOkLine } from '../composer/sentHint';
import './asks.css';

/**
 * 认「那一家」要的那一份(登记表在里头:名字、颜色、有没有 logo)。
 * **可缺** —— 缺了就是这张卡原来的样子,名字前没有图(老用例、老调用方照旧)。
 */
export type AgentsOf = Pick<WorkbenchState, 'agent_registry'> | undefined;

export function PhoneQuestionAsk({ question, answer, onReceipt, now }: {
  question: PendingQuestionView;
  answer(answers: readonly QuestionAnswerItem[]): Promise<string | undefined>;
  onReceipt?(text: string): void;
  /** `/state.now` —— 「已送到 · 10:38」那个时刻照电脑的钟写(src/clock.ts)。缺席 = 只写「已送到」。 */
  now?: string;
}) {
  const [picked, setPicked] = useState<Record<string, readonly string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** 送到了那一行:算出来就冻住(这一页跟着 /state 一拍一拍地刷,`now` 每拍都新)。 */
  const [sent, setSent] = useState<string | undefined>(undefined);
  const items = question.questions;
  const quick = items.length === 1 && items[0]?.multi === false;
  const submit = (answers: readonly QuestionAnswerItem[]): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setSent(undefined);
    void answer(answers).then((failed) => {
      setBusy(false);
      if (failed !== undefined) { setError(failed); return; }
      // 送到了才提示(2026-10-03):那颗 toast 在「等你确认」那一页上她看不见,所以这一行就摆在卡里。
      setSent(sentOkLine(now));
      onReceipt?.('答上了,接着办');
    });
  };
  const collected = (): QuestionAnswerItem[] => items.map((item) => {
    const said = (custom[item.id] ?? '').trim();
    return { id: item.id, selected: said !== '' && !item.multi ? [] : [...(picked[item.id] ?? [])], ...(said === '' ? {} : { custom: said }) };
  });
  const ready = collected().some((one) => one.selected.length > 0 || one.custom !== undefined);
  return (
    <section className="ba-ask" aria-label={`${askSubject(question.task_title)}问你`}>
      <p className="ba-ask__head">
        {askSubject(question.task_title, 18)}问你{items[0]?.header !== undefined ? <> · <strong>{items[0].header}</strong></> : null}
      </p>
      {items.map((item, index) => (
        <div key={item.id} className="ba-ask__item">
          {index > 0 && item.header !== undefined && <p className="ba-ask__sub">{item.header}</p>}
          <p className="ba-ask__say">{item.question}</p>
          {item.detail !== undefined && <p className="ba-ask__detail">{item.detail}</p>}
          {item.options.length > 0 && (
            <div className="ba-ask__options">
              {item.options.map((option) => {
                const on = (picked[item.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    className="ba-ask__option"
                    data-on={on}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => {
                      if (quick) { submit([{ id: item.id, selected: [option.label] }]); return; }
                      setPicked((prev) => {
                        const now = prev[item.id] ?? [];
                        const next = item.multi ? (now.includes(option.label) ? now.filter((one) => one !== option.label) : [...now, option.label]) : [option.label];
                        return { ...prev, [item.id]: next };
                      });
                    }}
                  >
                    <span className="ba-ask__option-text">{option.text}</span>
                    {option.note !== undefined && <span className="ba-ask__option-note">{option.note}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="ba-ask__own">
            {/*
              送到了那一行(2026-10-03,卡 claude/phone-saybox-pinned):「已送到 · 10:38」。
              **摆在 `.ba-ask__own` 里面**(靠 flex-wrap 占满一行排在框上面)—— 这一格吸底,
              摆在它外面的话,卡一长它就跟着滑出屏幕,等于没提示。没送到不出现。
            */}
            {index === items.length - 1 && sent !== undefined && <p className="ba-ask__sent" role="status" data-ask="sent">{sent}</p>}
            <input
              type="text"
              aria-label="我自己说"
              placeholder="我自己说:不照上面几个,直接写一句"
              value={custom[item.id] ?? ''}
              disabled={busy}
              enterKeyHint="send"
              onChange={(event) => { const value = event.target.value; setCustom((prev) => ({ ...prev, [item.id]: value })); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (collected().some((one) => one.selected.length > 0 || one.custom !== undefined)) submit(collected());
              }}
            />
            {/* 与电脑一模一样(卡 M 补):同一句提示、「回复」一直摆着(没写字时是灰的)。 */}
            {index === items.length - 1 && (
              <button type="button" className="ba-ask__send" disabled={busy || !ready} onClick={() => submit(collected())}>回复</button>
            )}
          </div>
        </div>
      ))}
      {error !== undefined && <p className="ba-ask__err" role="alert">{error}</p>}
    </section>
  );
}

export function PhoneApprovalAsk({ approval, answer, onReceipt, agents }: {
  approval: PendingApprovalView;
  answer(allow: boolean, scope?: 'kind'): Promise<{ ok: true; granted?: string; merged?: number } | { ok: false; error: string }>;
  onReceipt?(text: string): void;
  /** 认那几家用的(卡 LG3:派活确认点上每一家名字前那张 logo)。缺了就没有图。 */
  agents?: AgentsOf;
}) {
  const [busy, setBusy] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  // 各家额度默认收起(卡 UX):这一问是「派给谁」,不是「各家还剩多少」。
  const [quotaOpen, setQuotaOpen] = useState(false);
  const run = (allow: boolean, scope?: 'kind'): void => {
    if (busy) return;
    setBusy(true);
    void answer(allow, scope).then((result) => {
      setBusy(false);
      if (!result.ok) { onReceipt?.(result.error); return; }
      if (scope === 'kind') {
        onReceipt?.(`记下了:这件事里${result.granted ?? '同类的'}都允许,后面同类的不再问你`);
        return;
      }
      onReceipt?.(allow ? '批了,接着办' : '没批,它会换个办法,或者停下来问你');
    });
  };
  const raw = approval.raw;
  const hasRaw = raw !== undefined && (raw.reason !== undefined || raw.command !== undefined);
  /**
   * 大字第一行、收起来那一行、「允许」那颗键上的字(2026-09-28,卡 UX):
   * 「把「验证自我迭代能力」派给 Claude?」—— 哪件事、派给谁,一眼看得清。
   */
  const face = dispatchApprovalFace(approval);
  const quotas = (list: readonly NonNullable<typeof approval.options>[number][], label: string) => (
    <ul className="ba-ask__options" aria-label={label}>
      {list.map((option) => (
        <li key={option.family} data-state={option.state} data-chosen={option.chosen === true} data-stale={option.stale === true ? 'true' : undefined}>
          {/* 名字前那一家的 logo(卡 LG3):「派给 Claude(本周还剩约 62%)」一眼认出是哪个应用。 */}
          <AgentIcon agent={option.family} state={agents} size={AGENT_ICON_SIZE_SMALL} />
          {' '}
          <b>{option.family === 'dsh' ? '事务官自己做' : option.title}</b>
          {' '}
          <span>{option.quota}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="ba-ask ba-ask--approval" aria-label={`${askSubject(approval.task_title)}要你批一件事`}>
      <p className="ba-ask__head">{askSubject(approval.task_title, 18)}要你批一件事</p>
      <p className="ba-ask__say ba-ask__say--strong" data-head={face.chosen !== undefined ? 'true' : undefined}>{face.headline}</p>
      {approval.why !== undefined && <p className="ba-ask__detail">为什么:{approval.why}</p>}
      {approval.scope !== undefined && <p className="ba-ask__scope">{approval.scope}</p>}
      {/*
        派活前那一问(卡 O):能派给的几家。**默认只摆这次问的那一家**(卡 UX,2026-09-28):
        从前一整面各家额度压在正文里,他照着列表第一行那件事点了「允许这一次」。别家收起成一行,点「展开看额度」才摆。
      */}
      {face.chosen !== undefined && quotas([face.chosen], '这次问的那一家')}
      {face.othersLine !== undefined && (
        <p className="ba-ask__others">
          {face.othersLine}{' '}
          <button type="button" className="ba-ask__raw-toggle" aria-expanded={quotaOpen} onClick={() => setQuotaOpen((open) => !open)}>
            {quotaOpen ? '收起额度' : '展开看额度'}
          </button>
        </p>
      )}
      {quotaOpen && face.others.length > 0 && quotas(face.others, '能派给的几家')}
      {face.chosen === undefined && approval.options !== undefined && approval.options.length > 0 && quotas(approval.options, '能派给的几家')}
      <div className="ba-ask__acts">
        <button type="button" className="ba-ask__yes" disabled={busy} onClick={() => run(true)}>{face.yes}</button>
        {approval.kind !== undefined && (
          <button type="button" className="ba-ask__ghost" disabled={busy} onClick={() => run(true, 'kind')}>这件事里{keepNamesWhole(approval.kind.title)}都允许</button>
        )}
        <button type="button" className="ba-ask__ghost" disabled={busy} onClick={() => run(false)}>不行</button>
      </div>
      {hasRaw && (
        <button type="button" className="ba-ask__raw-toggle" aria-expanded={rawOpen} onClick={() => setRawOpen((open) => !open)}>{rawOpen ? '收起原始' : '看原始'}</button>
      )}
      {rawOpen && hasRaw && (
        <pre className="ba-ask__raw" aria-label="原始请求(开发者用)">{[raw?.reason, raw?.command].filter((line): line is string => line !== undefined).join('\n\n')}</pre>
      )}
    </section>
  );
}

/**
 * 「改「butler-questions」这个仓库」里的名字不拆开折行(窄屏上以前折成「butler- / questions」)。
 * 只包「…」里那一段;名字外面的中文照常折。
 */
function keepNamesWhole(text: string) {
  return text.split(/(「[^」]*」)/).filter((part) => part !== '').map((part, index) => (
    part.startsWith('「') ? <span key={index} className="ba-ask__name">{part}</span> : part
  ));
}

/** 那一家叫什么(会话来源按字符串:认得的用名字,认不得的原样)。 */
const AGENT_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
const ASK_HEADS: Readonly<Record<NonNullable<SessionView['ask']>['kind'], string>> = {
  choose: '在等你选',
  approve: '在等你点头',
  do: '在等你动手',
  review: '在等你看',
};

/**
 * 「Codex 在等你选」(与电脑 workbench-plugin/src/waiting.ts 的 sessionAskHead 同一个说法)。
 *
 * 名字**先问主人**(登记表 `/state.agent_registry`,2026-10-03 审计第四节第 2 条):窗口型那几家
 * (豆包办公 / Muse / Manus)的家 id 就是 App 的包标识,下面那张退路表里没有 —— 不问登记表就念出包标识来。
 */
export function sessionAskHead(session: Pick<AskSessionView, 'agent' | 'ask'>, agents?: AgentsOf): string {
  const name = registryAgentName(session.agent, agents) ?? AGENT_NAMES[session.agent] ?? session.agent;
  const child = session.ask?.child;
  const title = child?.title?.trim() ?? '';
  const chars = [...title];
  // 子任务(后台任务)在等他:「Claude 的子任务「整理测试」在等你点头」
  const who = child === undefined ? name : `${name} 的子任务${title === '' ? '' : `「${chars.length <= 12 ? title : `${chars.slice(0, 12).join('')}…`}」`}`;
  const gap = /[A-Za-z0-9]$/.test(who) ? ' ' : '';
  return session.ask === undefined ? `${who}${gap}在等你` : `${who}${gap}${ASK_HEADS[session.ask.kind]}`;
}

/**
 * 别家的会话停着在等他(2026-09-25,卡 T)—— 手机「等你确认」那一页上的一张,跟事务官的提问卡同一种样子。
 * 抬头一句「Codex 在等你选」+ 一句人话的问题 + 它给的选项;送得回去就能点、能「我自己说」;
 * 送不回去的如实写「这一问得在电脑上的 Claude 里回答」(手机上够不着那家的窗口)。
 * 与电脑 workbench-plugin/src/client/SessionAsk.tsx 同一件事(两个仓库目录互不 import,各写一份)。
 */
/** 权限弹窗上那颗键底下配的一句中文(与电脑 workbench-plugin/src/server/approvalKeys.ts 的 APPROVAL_DOES_TEXT 同一句)。 */
const APPROVAL_DOES_TEXT: Readonly<Record<SessionApprovalKey['does'], string>> = { once: '批准这一次', deny: '不批' };

type PickResult = { ok: true; confirmed: boolean; text?: string } | { ok: false; desk: boolean; text: string };
type ApprovalReadResult = { ok: true; keys: readonly SessionApprovalKey[] } | { ok: false; desk: boolean; text: string };

/**
 * **权限弹窗那一问:摆它弹窗上真实的那几颗键**(2026-10-01,卡 AP「手机替她批准」)。
 *
 * 维护者 10-01 午饭在外面:「找到那个会话是在待确认里,输入回复内容之后,说发不出去」—— 打字批不了权限弹窗。
 * 所以这里**不摆输入框**:读过了就摆键(键名是壳读到的原字,底下一句中文);读得了还没读 → 打开就去读一次;
 * 读不到 → 如实说 + 「再看一次」;这一路读不了(旧壳)→ 一句到电脑上点。按下去核实过才说批了。
 */
function PhoneApprovalKeys({ permission, where, approval, pick, onReceipt, onError }: {
  permission: NonNullable<NonNullable<SessionView['ask']>['permission']>;
  where: string;
  approval?(): Promise<ApprovalReadResult>;
  pick?(label: string): Promise<PickResult>;
  onReceipt?(text: string): void;
  onError(text: string | undefined): void;
}) {
  const [keys, setKeys] = useState<readonly SessionApprovalKey[] | undefined>(permission.keys);
  const [reading, setReading] = useState(false);
  const [why, setWhy] = useState<string | undefined>(permission.why);
  const [busy, setBusy] = useState(false);
  // 别处(电脑上 / 另一台手机)读过了,快照里带上了那几颗 —— 跟上。
  useEffect(() => { if (permission.keys !== undefined) setKeys(permission.keys); }, [permission.keys]);
  const read = (): void => {
    if (approval === undefined || reading) return;
    setReading(true);
    setWhy(undefined);
    void approval().then((result) => {
      setReading(false);
      if (result.ok) { setKeys(result.keys); return; }
      setWhy(result.text);
    });
  };
  // 读得了、还没读过:打开这张卡就去读一次(她点开就是要处理它)。
  useEffect(() => {
    if (permission.keys === undefined && permission.readable === true && approval !== undefined) read();
    // 只在打开时读一次;「再看一次」走按钮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const press = (label: string): void => {
    if (busy || pick === undefined) return;
    setBusy(true);
    onError(undefined);
    void pick(label).then((result) => {
      setBusy(false);
      if (result.ok) {
        onReceipt?.(result.text ?? (result.confirmed ? `已替你按了「${label}」` : `按了「${label}」,没看到它收下`));
        if (!result.confirmed && result.text !== undefined) onError(result.text);
        return;
      }
      onError(result.text);
    });
  };
  if (keys !== undefined && keys.length > 0 && pick !== undefined) {
    return (
      <div className="ba-ask__options" aria-label="它弹窗上的键">
        {keys.map((key) => (
          <button key={key.label} type="button" className="ba-ask__option" disabled={busy} onClick={() => press(key.label)}>
            <span className="ba-ask__option-text">{key.label}</span>
            <span className="ba-ask__option-note">{APPROVAL_DOES_TEXT[key.does]}</span>
          </button>
        ))}
      </div>
    );
  }
  if (reading) return <p className="ba-ask__scope">在看它弹窗上有哪几颗键…</p>;
  if (why !== undefined) {
    return (
      <>
        <p className="ba-ask__scope">{why}</p>
        {approval !== undefined && <button type="button" className="ba-ask__send" onClick={read}>再看一次</button>}
      </>
    );
  }
  return <p className="ba-ask__scope">{where}</p>;
}

/**
 * 那一问的原文超过这么多字就先折起来,一颗「展开全文」摊开(2026-10-04,卡 `claude/ask-with-context`)。
 *
 * 为什么是 140:手机一行约 18 个字,140 字约合八行 —— 一屏里还留得下选项与「我自己说」那个框
 * (那两样要够得着她的拇指)。比这短的不折:折起来反而多一颗键要点。
 * 她摊开过一次之后这一张就一直摊着(不替她收回去)。
 */
export const ASK_FULL_FOLD_CHARS = 140;

export function PhoneSessionAsk({ session, answer, pick, say, dismiss, onReceipt, agents, approval, now, context, openSession }: {
  /** 两路来源同一种形状(2026-10-03,审计第四节):会话文件那几家 + 登记表里读窗口读出来的那几家。 */
  session: AskSessionView;
  answer(text: string): Promise<{ ok: true } | { ok: false; desk: boolean; text: string; permission?: true }>;
  /**
   * **读那家权限弹窗上有哪几颗键**(2026-10-01,卡 AP;`POST /sessions/approval/read`)。
   * 缺席 = 这一路没接,权限弹窗那一问照旧一句到电脑上点。
   */
  approval?(): Promise<ApprovalReadResult>;
  /**
   * **替他点它弹的框上那一项**(2026-09-28,卡 WQ;`ask.press` 为真时才摆得点的选项)。
   * 回 `confirmed:false` = 点了、没看到它收下 —— 照 `text` 那句人话说,不说成答上了。缺席 = 这一路没接,照旧只摆字。
   */
  pick?(label: string): Promise<{ ok: true; confirmed: boolean; text?: string } | { ok: false; desk: boolean; text: string }>;
  /**
   * **替她把她自己那句话写进它那个提问面板**(2026-09-28,卡 AT;`ask.write` 为真时才摆「我自己说」那个框)。
   * 维护者原话:「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
   * 与 `pick` 同一个口(`POST /asks/answer`,`text` 那一格),回 `confirmed:false` = 写进去了没看到它收下,
   * 照 `text` 那句人话说,**不说成答上了**。缺席 = 这一路没接,照旧只写「得在电脑上…」。
   */
  say?(text: string): Promise<{ ok: true; confirmed: boolean; text?: string } | { ok: false; desk: boolean; text: string }>;
  /** 「不用管这条」(按内容判出来的才有):回 undefined = 拿掉了。 */
  dismiss?(): Promise<string | undefined>;
  onReceipt?(text: string): void;
  /** 认那一家用的(卡 LG3:「Grok Bot 在等你选」那一句前面那张 logo)。缺了就没有图。 */
  agents?: AgentsOf;
  /**
   * `/state.now` —— 「已送到 · 10:38」那个时刻照**电脑的钟**写(口径见 src/clock.ts)。
   * 缺席 / 空字符串(还没连上)= 只写「已送到」,不拿手机的墙钟凑一个数。
   */
  now?: string;
  /**
   * **它刚才在干什么**(2026-10-04,卡 `claude/ask-with-context`):问话之前的最近几轮原文 + 在哪个项目。
   * 上层(`StagePage`)把现成那一段递进来(`items/SessionRounds.tsx` 的 `AskRounds`)——
   * 这张卡自己不取数(它这一份入参全是注入的,老用例照旧 render 得起来)。缺席 = 不摆那一段。
   */
  context?: ReactNode;
  /**
   * **打开整段对话**(2026-10-04,同一张卡):点下去进那条会话的全文页(`GET /sessions/transcript` 那一页)。
   * 缺席 = 上层没接那条路 → **不画那颗键**(不给按下去没反应的键,D13)。
   */
  openSession?(): void;
}) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [deskNote, setDeskNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /** 那一问的原文摊开了没有(2026-10-04,卡 `claude/ask-with-context`)。 */
  const [sayOpen, setSayOpen] = useState(false);
  /**
   * 送到了那一行(2026-10-03,卡 claude/phone-saybox-pinned)。维护者:「发送成功最好给个小提示」——
   * 原来成功那一下只有 `onReceipt` 那颗 toast,而这一页是 `background: #000` 的整屏覆盖层、
   * 与 toast 同一档 z-index 又排在它后面:整条提示画在这一页后面,她根本看不见。
   * **只有工作台核实过(`confirmed: true`)才算送到**;「写进去了没看到它收下」照旧只说那句原话。
   */
  const [sent, setSent] = useState<string | undefined>(undefined);
  /** 打字回来说撞上的是权限弹窗(老版工作台没给 `permission` 那一格时):那一句话,据此切到按键。 */
  const [permissionNow, setPermissionNow] = useState<string | undefined>(undefined);
  const ask = session.ask;
  if (ask === undefined) return null;
  /**
   * ★ **权限弹窗那一问**(2026-10-01,卡 AP):不摆输入框、不摆选项,摆它弹窗上那几颗键。
   * `permission` 缺席、但打字回来说是权限弹窗(`permissionNow`)→ 当它读得了,去读一次。
   */
  const permission = ask.permission ?? (permissionNow === undefined ? undefined : { readable: true as const });
  if (permission !== undefined) {
    return (
      <section className="ba-ask" aria-label={sessionAskHead(session, agents)}>
        <p className="ba-ask__head">
          <AgentIcon agent={session.agent} state={agents} size={AGENT_ICON_SIZE_SMALL} />
          {' '}
          {sessionAskHead(session, agents)}{session.title !== undefined && session.title.trim() !== '' ? <> · <strong>{session.title}</strong></> : null}
        </p>
        <div className="ba-ask__item">
          <p className="ba-ask__say">{ask.question}</p>
          {permissionNow !== undefined && <p className="ba-ask__scope">{permissionNow}</p>}
          <PhoneApprovalKeys
            permission={permission}
            where={ask.where ?? '这一问得在电脑上那家的窗口里点'}
            {...(approval === undefined ? {} : { approval })}
            {...(pick === undefined ? {} : { pick })}
            {...(onReceipt === undefined ? {} : { onReceipt })}
            onError={setError}
          />
        </div>
        {error !== undefined && <p className="ba-ask__err" role="alert">{error}</p>}
      </section>
    );
  }
  const answerable = deskNote === undefined && (ask.reply === 'window' || ask.reply === 'cli');
  /**
   * ★ 打字送不进那个框,可**框上那几颗键点得下去**(卡 WQ):工作台把那家叫到台前按下去、再核实一次。
   * 手机上他点一下就算答了 —— 这正是维护者说「我帮你传不了话」那一句要的。
   */
  const pressable = deskNote === undefined && ask.press === true && pick !== undefined && (ask.options ?? []).length > 0;
  const pickable = answerable || pressable;
  /**
   * ★ **她自己打的那一句也送得进去**(2026-09-28,卡 AT):工作台把她那句**原文一字不改**写进
   * 那家提问面板里的自由作答框、按**面板自己**那颗发送键,再核实一次。
   * 所以弹框那一问这里也摆「我自己说」——从前那半句「要自己说一句,得在电脑上…」在新壳上不再出现。
   */
  const writable = deskNote === undefined && ask.write === true && say !== undefined;
  /** 摆不摆「我自己说」那个框(两条路:打字送回会话 / 写进它那个面板)。 */
  const ownBox = answerable || writable;
  const press = (label: string): void => {
    if (busy || pick === undefined) return;
    setBusy(true);
    setError(undefined);
    setSent(undefined);
    void pick(label).then((result) => {
      setBusy(false);
      if (result.ok) {
        if (result.confirmed) setSent(sentOkLine(now));
        onReceipt?.(result.text ?? (result.confirmed ? `已替你答了:${label}` : `点了「${label}」,但没看到它收下`));
        if (!result.confirmed && result.text !== undefined) setError(result.text);
        return;
      }
      if (result.desk) { setDeskNote(result.text); return; }
      setError(result.text);
    });
  };
  /** 她自己那句话:**写进它那个面板**(卡 AT)。核不上就照服务端那句原话说,不说成答上了。 */
  const sayOwn = (text: string): void => {
    const said = text.trim();
    if (busy || say === undefined || said === '') return;
    setBusy(true);
    setError(undefined);
    setSent(undefined);
    void say(said).then((result) => {
      setBusy(false);
      if (result.ok) {
        if (result.confirmed) { setCustom(''); setSent(sentOkLine(now)); }
        onReceipt?.(result.text ?? (result.confirmed ? `已替你答了:${said}` : '写进去了,但没看到它收下'));
        if (!result.confirmed && result.text !== undefined) setError(result.text);
        return;
      }
      if (result.desk) { setDeskNote(result.text); return; }
      setError(result.text);
    });
  };
  /**
   * ★ **问的是什么:原文**(2026-10-04,卡 `claude/ask-with-context`)。维护者原话:
   * 「每次要确认内容的信息都很短,我都不知道发生了什么」。
   * `ask.question` 是服务端洗过、截到 60 字的一句人话(首页那一行、来电里念的都是它);
   * `ask.full.question` 是那家弹窗里的原字。有原文摆原文(长了折起来),没有照旧摆短的那一句 —— 两条路都不编。
   */
  const sayText = ask.full?.question ?? ask.question;
  const foldable = Array.from(sayText).length > ASK_FULL_FOLD_CHARS;
  const sayFolded = foldable && !sayOpen;
  /**
   * 选项**看见的是原文、送回去的还是工作台给的那一颗**。两份一一对应(同一个 `step.options`、
   * 同一道「label 空的不算」过滤),**只在条数一样时才配对** —— 条数不一样宁可摆短的那一份,不猜哪一颗对哪一颗。
   */
  const fullOptions = ask.full?.options !== undefined && ask.full.options.length === (ask.options ?? []).length ? ask.full.options : undefined;
  const send = (text: string): void => {
    const said = text.trim();
    if (busy || said === '') return;
    setBusy(true);
    setError(undefined);
    setSent(undefined);
    void answer(said).then((result) => {
      setBusy(false);
      if (result.ok) { setCustom(''); setSent(sentOkLine(now)); onReceipt?.('送过去了,它接着办'); return; }
      // 撞上的是权限弹窗(卡 AP):收起输入框,切到「批准 / 拒绝」那几颗键。
      if (result.desk && result.permission === true) { setCustom(''); setPermissionNow(result.text); return; }
      if (result.desk) { setDeskNote(result.text); return; }
      setError(result.text);
    });
  };
  return (
    <section className="ba-ask" aria-label={sessionAskHead(session, agents)}>
      <p className="ba-ask__head">
        {/* 「Grok Bot 在等你选」前面那张 logo(卡 LG3):是哪一家在等他,看图比看字快。 */}
        <AgentIcon agent={session.agent} state={agents} size={AGENT_ICON_SIZE_SMALL} />
        {' '}
        {sessionAskHead(session, agents)}{session.title !== undefined && session.title.trim() !== '' ? <> · <strong>{session.title}</strong></> : null}
      </p>
      <div className="ba-ask__item">
        {/* 弹窗那一问上面那行小标题(「导出 PDF 走哪一条」):它给了才有,不替它编一个。 */}
        {ask.full?.header !== undefined && <p className="ba-ask__header">{ask.full.header}</p>}
        <p className="ba-ask__say" data-testid="ask-say" data-folded={String(sayFolded)}>{sayText}</p>
        {foldable && (
          <button type="button" className="ba-ask__raw-toggle" aria-expanded={sayOpen} onClick={() => setSayOpen((open) => !open)}>
            {sayOpen ? '收起' : '展开全文'}
          </button>
        )}
        {ask.options !== undefined && ask.options.length > 0 && (pickable
          ? (
              <div className="ba-ask__options">
                {ask.options.map((option, index) => {
                  const shown = fullOptions?.[index] ?? option;
                  return (
                    <button key={option.label} type="button" className="ba-ask__option" disabled={busy} onClick={() => (answerable ? send(option.label) : press(option.label))}>
                      <span className="ba-ask__option-text">{shown.label}</span>
                      {shown.note !== undefined && <span className="ba-ask__option-note">{shown.note}</span>}
                    </button>
                  );
                })}
              </div>
            )
          : (
              // 送不回去:选项只摆字(不画成按不动的按钮 —— 不懂技术的人会以为坏了)。
              <ul className="ba-ask__plain-options" aria-label="它给的选项">
                {ask.options.map((option, index) => {
                  const shown = fullOptions?.[index] ?? option;
                  return (
                    <li key={option.label}>
                      <span className="ba-ask__option-text">{shown.label}</span>
                      {shown.note !== undefined && <span className="ba-ask__option-note">{shown.note}</span>}
                    </li>
                  );
                })}
              </ul>
            ))}
        {ownBox
          ? (
              <div className="ba-ask__own">
                {/*
                  送到了那一行(2026-10-03,卡 claude/phone-saybox-pinned):「已送到 · 10:38」。
                  **就在这一格里**(靠 flex-wrap 占满一行排在框上面)—— 这一格吸底,摆在它外面的话
                  卡一长就跟着滑出屏幕,等于没提示。没送到不出现(下面那行原因自己会说)。
                */}
                {sent !== undefined && <p className="ba-ask__sent" role="status" data-ask="sent">{sent}</p>}
                <input
                  type="text"
                  aria-label="我自己说"
                  /* 弹框那一问:这一句是**写进它那个面板里的自由作答框**、按面板自己那颗发送键(卡 AT)。 */
                  placeholder={answerable ? '我自己说:直接写一句' : '我自己说:替你写进它那个框'}
                  value={custom}
                  disabled={busy}
                  enterKeyHint="send"
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    if (answerable) send(custom); else sayOwn(custom);
                  }}
                />
                {custom.trim() !== '' && (
                  <button type="button" className="ba-ask__send" disabled={busy} onClick={() => (answerable ? send(custom) : sayOwn(custom))}>回复</button>
                )}
              </div>
            )
          : (
              <>
                {/* 没有那个框(只能替她点选项)时这一行就摆在选项下面 —— 她刚按的那颗键旁边。 */}
                {sent !== undefined && <p className="ba-ask__sent" role="status" data-ask="sent">{sent}</p>}
                <p className="ba-ask__scope">
                  {/*
                    能替他点选项时这一行只说**剩下那半件**:要自己说一句才得去那家里说(卡 WQ)。
                    **她那句话也送得进去了(卡 AT)之后这一行整条不再出现** —— 上面就摆着「我自己说」那个框。
                  */}
                  {deskNote ?? (pressable
                    ? `上面那几项我能替你点;要自己说一句,${ask.where ?? '得在电脑上那家的窗口里回答'}`
                    : ask.where ?? '这一问得在电脑上那家的窗口里回答')}
                </p>
              </>
            )}
      </div>
      {/*
        ★ **它刚才在干什么**(2026-10-04,卡 `claude/ask-with-context`):问话之前的最近几轮原文 + 在哪个项目。
        她点进「等你确认」就是来看前因的,所以**默认就摊开**(不要她再点一下)。
        上层没递这一段(老调用方)就不画 —— 一个字都不编。
      */}
      {context}
      <div className="ba-ask__foot">
        {dismiss !== undefined && ask.by !== 'form' && (
          <button
            type="button"
            className="ba-ask__raw-toggle"
            onClick={() => { void dismiss().then((failed) => { if (failed !== undefined) setError(failed); else onReceipt?.('好,这条不算在等你了'); }); }}
          >
            不用管这条
          </button>
        )}
        {/* 「最近几轮」还不够就直接进那条会话的全文页(2026-10-04:她从前要自己去最近的会话里找)。 */}
        {openSession !== undefined && (
          <button type="button" className="ba-ask__raw-toggle" onClick={openSession}>打开整段对话</button>
        )}
      </div>
      {error !== undefined && <p className="ba-ask__err" role="alert">{error}</p>}
    </section>
  );
}
