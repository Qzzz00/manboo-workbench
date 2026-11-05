/**
 * 设置里的「资讯偏好」那一节(2026-09-21)。四样:
 *   - 每个项目「关注什么」(关键词,逗号分隔 —— 这是搜索用的原料,空着 = 那个项目不搜);
 *   - 每天几条;
 *   - 要不要播客;
 *   - 播报几分钟(3–6);
 *   - **用不用 Aiboo 的双主播播客**(2026-09-22,决策记录 B6)。
 *     关了就回到工作台自己合成的那段单人口播 —— 两条路都留着,开关在这儿。
 *   - **Aiboo 令牌**(2026-09-22)。Aiboo 把 `/api/dj/*` 的写路由关上了,
 *     推信源要带 `X-Aidj-Token`。这一格**只写不读**:填了发上去存在 Mac 上那份
 *     `aidj-config.json` 里,回来的只有「存没存」,所以这里永远只显示「已设置」。
 *
 * 项目名单跟着项目区走(服务端 syncInterests 干的),这里**只改关键词,不增删项目**:
 * 「有哪几个项目」是项目区的事,在两个地方都能改就一定会漂。
 *
 * 单开一个组件而不是写进 SettingsPage:那一页上同时有好几张卡在改,少碰一行少一次冲突。
 */
import { useEffect, useState } from 'react';
import { useSession } from '../session';
import { createNewsApi } from './newsApi';
import { EMPTY_NEWS, type NewsConfig, type NewsView } from './newsModel';
import type { AidjConfigPatch, AidjView } from './aidjModel';

/** `a,b、c` → `['a','b','c']`。中英文逗号、顿号、空格都当分隔符;空的丢掉、去重。 */
export function parseKeywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,，、;；\s]+/)) {
    const word = raw.trim();
    if (word === '' || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

export function NewsSettings() {
  const session = useSession();
  const [api] = useState(() => createNewsApi(session.client));
  const [view, setView] = useState<NewsView>(EMPTY_NEWS);
  const [state, setState] = useState<'loading' | 'ready' | 'off'>('loading');
  const [note, setNote] = useState<string | null>(null);
  /** 正在编辑的那几行文本(受控输入);失焦才发请求,不逐字发。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** AIDJ 那一块。null = 这台工作台没接(整块不摆,不摆一个点了没用的开关)。 */
  const [aidj, setAidj] = useState<AidjView | null>(null);
  /**
   * 正在填的那把 Aiboo 令牌。**存完就清空** —— 存好的那把服务端不回显,
   * 框子里留着一串星号只会让人以为「它在这儿」。
   */
  const [tokenDraft, setTokenDraft] = useState('');

  useEffect(() => {
    let alive = true;
    void api.view().then((result) => {
      if (!alive) return;
      if (!result.ok) { setState('off'); setNote(result.error); return; }
      setView(result.data);
      setState('ready');
      setDrafts(Object.fromEntries(result.data.config.interests.map(i => [i.project_id, i.keywords.join('、')])));
    });
    void api.aidj().then((result) => {
      if (!alive) return;
      setAidj(result.ok ? result.data : null);
    });
    return () => { alive = false; };
  }, [api]);

  const save = async (patch: Partial<NewsConfig>) => {
    const result = await api.setConfig(patch);
    if (!result.ok) { setNote(result.error); return; }
    setView(current => ({ ...current, config: result.data.config }));
    setNote(null);
  };

  const saveAidj = async (patch: AidjConfigPatch): Promise<boolean> => {
    const result = await api.setAidjConfig(patch);
    if (!result.ok) { setNote(result.error); return false; }
    setAidj(current => (current === null ? current : { ...current, config: result.data.config }));
    setNote(null);
    return true;
  };

  /** 存令牌。**只发 token 这一个键**,免得把别的开关顺手一起冲了。 */
  const saveToken = async () => {
    const token = tokenDraft.trim();
    if (token === '') return;
    if (await saveAidj({ token })) setTokenDraft('');
  };

  /** 清掉:发一个空串过去(服务端把字段删掉)。 */
  const clearToken = async () => {
    if (await saveAidj({ token: '' })) setTokenDraft('');
  };

  const saveKeywords = (projectId: string) => {
    const text = drafts[projectId] ?? '';
    const keywords = parseKeywords(text);
    const current = view.config.interests.find(i => i.project_id === projectId);
    if (current === undefined || JSON.stringify(current.keywords) === JSON.stringify(keywords)) return;
    void save({ interests: view.config.interests.map(i => (i.project_id === projectId ? { ...i, keywords } : i)) });
  };

  if (state === 'loading') return null;
  if (state === 'off') {
    return (
      <section className="ba-settings__sec">
        <h2 className="ba-inbox__h">资讯偏好</h2>
        <p className="ba-settings__line ba-settings__dim">{note ?? '这台工作台还没接资讯这一块。'}</p>
      </section>
    );
  }

  const config = view.config;
  return (
    <section className="ba-settings__sec">
      <h2 className="ba-inbox__h">资讯偏好</h2>
      <p className="ba-settings__line">
        <label>
          <input type="checkbox" checked={config.enabled} onChange={e => void save({ enabled: e.target.checked })} />
          {' '}每天早上搜一轮资讯
        </label>
      </p>
      <p className="ba-settings__line">
        <label>
          <input type="checkbox" checked={config.podcast} onChange={e => void save({ podcast: e.target.checked })} />
          {' '}做成一段可听的播客
        </label>
      </p>
      {aidj !== null && (
        <>
          <p className="ba-settings__line">
            <label>
              <input
                type="checkbox"
                checked={aidj.config.enabled}
                onChange={e => void saveAidj({ enabled: e.target.checked })}
              />
              {' '}用 Aiboo 的双主播播客
            </label>
          </p>
          <p className="ba-settings__line">
            <label>
              <input
                type="checkbox"
                checked={aidj.config.push_interests}
                disabled={!aidj.config.enabled}
                onChange={e => void saveAidj({ push_interests: e.target.checked })}
              />
              {' '}把今天搜到的资讯推给 Aiboo 当信源
            </label>
          </p>
          <p className="ba-settings__line">
            <span className="ba-settings__label">Aiboo 令牌</span>
            <input
              className="ba-settings__input"
              type="password"
              aria-label="Aiboo 令牌"
              autoComplete="off"
              placeholder={aidj.config.token_set ? '要换就填新的;不填就是不动' : '问维护者要一把'}
              value={tokenDraft}
              onChange={e => setTokenDraft(e.target.value)}
            />
            <span className="ba-settings__row">
              {aidj.config.token_set && <span className="ba-settings__dim">已设置</span>}
              <button type="button" className="ba-btn ba-btn--ghost" disabled={tokenDraft.trim() === ''} onClick={() => void saveToken()}>
                保存令牌
              </button>
              {aidj.config.token_set && (
                <button type="button" className="ba-btn ba-btn--ghost" onClick={() => void clearToken()}>
                  清掉令牌
                </button>
              )}
            </span>
          </p>
          <p className="ba-settings__line ba-settings__dim">
            这把令牌要问维护者要,只有往 Aiboo 推信源时才用得上(取节目不用)。
            它存在电脑上,填完这里就再也显示不出来;没填也不会坏 ——
            只是推不进去,双主播念的还是它自己那份资讯。
          </p>
          <p className="ba-settings__line ba-settings__dim">
            开着的时候,播客是 Aiboo 那套双主播对话节目(它每天早上 7 点生成);
            关了或者当天取不到,就回到工作台自己合成的那段单人口播 —— 下面那两项管的是后者。
          </p>
        </>
      )}
      <p className="ba-settings__line">
        播报时长
        <select
          className="ba-settings__select"
          value={config.podcast_minutes}
          onChange={e => void save({ podcast_minutes: Number(e.target.value) })}
        >
          {[3, 4, 5, 6].map(m => <option key={m} value={m}>{m} 分钟</option>)}
        </select>
      </p>
      <p className="ba-settings__line">
        每个项目每天
        <select
          className="ba-settings__select"
          value={config.per_project}
          onChange={e => void save({ per_project: Number(e.target.value) })}
        >
          {[3, 5, 8, 10].map(n => <option key={n} value={n}>{n} 条</option>)}
        </select>
      </p>

      {config.interests.length === 0
        ? <p className="ba-settings__line ba-settings__dim">还没有项目。项目是在 Mac 的工作台上建的,建了这里就会出现。</p>
        : config.interests.map(interest => (
          <p className="ba-settings__line" key={interest.project_id}>
            <span className="ba-settings__label">{interest.project_name} 关注什么</span>
            <input
              className="ba-settings__input"
              type="text"
              placeholder="几个关键词,逗号隔开;空着就不搜这个项目"
              value={drafts[interest.project_id] ?? ''}
              onChange={e => setDrafts(d => ({ ...d, [interest.project_id]: e.target.value }))}
              onBlur={() => saveKeywords(interest.project_id)}
            />
            {(interest.muted_sources?.length ?? 0) + (interest.muted_topics?.length ?? 0) > 0 && (
              <span className="ba-settings__dim">
                已不看:{[...(interest.muted_sources ?? []), ...(interest.muted_topics ?? [])].join('、')}
              </span>
            )}
          </p>
        ))}

      {note !== null && <p className="ba-settings__line ba-settings__dim">{note}</p>}
      <p className="ba-settings__line ba-settings__dim">
        搜索走工作台提供的服务;服务器上没配搜索时这一块会如实说没有,不会给你编几条。
        「不看了」会把那条的来源与主题记下来,下一轮不再搜它。
      </p>
    </section>
  );
}
