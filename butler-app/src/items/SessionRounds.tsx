/**
 * 一条会话的**最近几轮**(读会话那条现成的路:`GET /sessions/digest`)。
 *
 * 2026-10-04(卡 `claude/ask-with-context`)从 `items/InboxPage.tsx` 的 `SessionDetail` 里搬出来 ——
 * 维护者原话:「每次要确认内容的信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」,
 * 于是「等你确认」那张卡也要摆这几轮。**不另写一套读法**:事项页那一张与「等你确认」那张卡
 * 从此读的是同一处(同一条接口、同一个「那条会话一动就再读一次」的节拍、同一句读不到时说的话)。
 *
 * 全是数出来的、原样的(C2:判断都在工作台,手机只渲染),一个字不经模型。
 */
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import type { SessionDigestRound, SessionDigestView } from '../api/protocol';
import { formatClock } from '../hooks';

/**
 * **最近几轮要及时**(2026-09-27,卡 PS,维护者原话第一句):开着的时候这么久再读一次
 * (原来 15 秒 —— 他站在那儿等一句回话,15 秒像坏了)。
 */
export const DIGEST_POLL_MS = 4_000;

/**
 * 读不到前面那段对话时说的那一句(2026-10-04,卡 `claude/ask-with-context`)。
 * 出门走中转、电脑睡了都读不到 —— **如实说一句,那一问本身照样答得了**,不拿旧的凑、不编一段上下文。
 * 真正的原因紧跟在这一句下面(服务端 / 通道那句原话)。
 */
export const ASK_CONTEXT_NO_READ = '这会儿取不到前面的对话';

export interface DigestState {
  view?: SessionDigestView;
  error?: string;
}

/**
 * 当场读那条会话的摘要(标题、项目、在做什么、最近几轮)。
 * `beat` = 那条会话此刻的动静(变了就立刻再读一次;会话没了也算一种动静);`again` = 「现在就再读一次」的把手。
 */
export function useSessionDigest(client: ApiClient, agent: string, sessionId: string, beat: string, again = 0): DigestState {
  const [view, setView] = useState<SessionDigestView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (sessionId === '') return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await client.json<SessionDigestView>(`/sessions/digest?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(sessionId)}`);
        if (!alive) return;
        if (!res.ok || res.data === undefined) { setError(res.ok ? '读不到这条会话的记录' : res.error); return; }
        setView(res.data);
        setError(undefined);
      }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : '连不上工作台'); }
    };
    void load();
    const timer = setInterval(() => { void load(); }, DIGEST_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [agent, sessionId, client, beat, again]);
  return { ...(view === undefined ? {} : { view }), ...(error === undefined ? {} : { error }) };
}

/**
 * 那几轮本身(她说的 / 它说的 / 数出来的「做了什么」),原样摆。
 * 读不到、还在读、一轮都没有:各说一句实话,不画一段空白(2026-09-28,卡 WR:照工作台那句 `rounds_note` 说)。
 */
export function SessionRoundsList({ state, name, now, label = '最近几轮', noRead }: {
  state: DigestState;
  /** 那一家叫什么(「它」那一句前面的小字)。 */
  name: string;
  /** `/state.now` —— 时刻照电脑的钟写(src/clock.ts)。 */
  now?: string;
  label?: string;
  /** 读不到时先说的那一句(「等你确认」那张卡上是 {@link ASK_CONTEXT_NO_READ});缺席 = 只说原因。 */
  noRead?: string;
}) {
  const { view, error } = state;
  // CLI reader 的原始轮形是 {k:'ask'|'reply',text,at};旧 transcript source 仍用 ask/reply/did。
  const rounds = view?.rounds as readonly (SessionDigestRound & { k?: unknown; text?: unknown })[] | undefined;
  return (
    <section className="ba-sheet__rounds" aria-label={label}>
      <p className="ba-sheet__hint">{label}</p>
      {error !== undefined && view === undefined
        ? (
            <>
              {noRead !== undefined && <p className="ba-sheet__hint" role="status">{noRead}</p>}
              <p className="ba-sheet__hint">{error}</p>
            </>
          )
        : view === undefined
          ? <p className="ba-sheet__hint" role="status">正在读这条会话…</p>
          : rounds?.length === 0
            // 读它的窗口读出来的那几条没有对话记录可读(卡 WR):照工作台那句话说。
            ? <p className="ba-sheet__hint">{view.rounds_note ?? '这条会话里还没读出能给你看的几轮。'}</p>
            : (
                <ol className="ba-rounds">
                  {rounds?.map((round, index) => {
                    const ask = round.ask ?? (round.k === 'ask' && typeof round.text === 'string' ? round.text : undefined);
                    const reply = round.reply ?? (round.k === 'reply' && typeof round.text === 'string' ? round.text : undefined);
                    return (
                    <li key={`${round.at ?? ''}-${index}`}>
                      {ask !== undefined && <p className="ba-rounds__ask"><small>你</small>{ask}</p>}
                      {reply !== undefined && <p className="ba-rounds__reply"><small>{name}</small>{reply}</p>}
                      {(round.did !== undefined || round.at !== undefined) && <small className="ba-rounds__did">{[round.did, formatClock(round.at, now)].filter(Boolean).join(' · ')}</small>}
                    </li>
                    );
                  })}
                </ol>
              )}
    </section>
  );
}

/** 在哪个项目:「未归类」说成「没认出是哪个项目」(与电脑 client/SessionRounds.tsx 同一句)。 */
export function projectLine(project: string | undefined): string | undefined {
  if (project === undefined || project.trim() === '') return undefined;
  return project === '未归类' ? '没认出是哪个项目' : `在「${project}」项目里`;
}

/**
 * 「等你确认」那张卡下面那一段:**它刚才在干什么**(2026-10-04,卡 `claude/ask-with-context`)。
 * = 在哪个项目 + 最近几轮原文。读的是上面那条现成的路,读不到就照 {@link ASK_CONTEXT_NO_READ} 如实说。
 *
 * 这一段自己管自己读:上层(`StagePage`)只递「哪一家、哪条会话」。她点进「等你确认」就是来看前因的,
 * 所以**默认就摊开**(电脑球下那一区是另一回事:那儿一屏要摆几张卡,收着、点一下才摊 —— 见
 * `workbench-plugin/src/client/SessionAsk.tsx`)。
 */
export function AskRounds({ client, agent, name, sessionId, now, beat = '' }: {
  client: ApiClient;
  agent: string;
  name: string;
  sessionId: string;
  now?: string;
  /** 那条会话此刻的动静(变了就再读一次)。 */
  beat?: string;
}) {
  const state = useSessionDigest(client, agent, sessionId, beat);
  const project = projectLine(state.view?.project);
  return (
    <div className="ba-ask__context">
      {project !== undefined && <p className="ba-ask__project">{project}</p>}
      <SessionRoundsList state={state} name={name} {...(now === undefined ? {} : { now })} label="它刚才在干什么" noRead={ASK_CONTEXT_NO_READ} />
    </div>
  );
}
