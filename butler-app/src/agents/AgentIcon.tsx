/**
 * 手机上「那一家」名字前面那张 16–20px 的圆角图标(2026-09-26,卡 LG3)。**手机端只有这一个组件画它** ——
 * 首页、事项页、等你确认、设置里每一处都是它,所以「取不到就退回色点」这条退路也只有一处。
 *
 * - 画不画得成只看两件事:登记表里这一条 `icon` 为真(工作台那侧真取到了),而且手机这边已经有那份字节。
 * - **取不到就是卡 Q 那颗色点**(颜色 = 登记表里这一家的 `color`),连状态点那一颗也照旧 ——
 *   markup 与没有这张图之前一个样,所以「工作台是旧版 / 人在外面 / 没装那个 App」看起来不是坏了,就是原来的样子。
 * - 有图时那颗**状态点挪到图的右下角当角标**(同电脑那侧卡 LG 的做法):语义一点没丢。
 * - 图**不参与读屏**(`alt="" aria-hidden`):名字就在旁边,念两遍是噪音。
 *
 * 与电脑 workbench-plugin/src/client/AgentIcon.tsx 是同一件事的两份(两个仓库目录互不 import,各写一份)。
 */
import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { SessionContext } from '../session';
import type { AgentIconStore } from './agentIcons';
import type { CardDot } from '../items/itemsModel';
import type { WorkbenchState } from '../api/protocol';
import './agentIcon.css';

/** 名字前那张图多大。16–20px 之间(维护者定的那一档);默认 18。 */
export const AGENT_ICON_SIZE = 18;
/** 卡片行里那一格用小一号的(那一行本来就挤)。 */
export const AGENT_ICON_SIZE_SMALL = 16;

export function useAgentIconStore(): AgentIconStore | undefined {
  // 用 useContext 而不是 useSession:有些用例单独渲染一个组件,外面没有 Provider —— 那时就是色点。
  return useContext(SessionContext)?.agentIcons;
}

/**
 * 这一家此刻能画的那张图。`enabled` 为假(登记表说它没有图 / 老工作台)时一个请求都不发。
 * **取图在 effect 里要**(`want`),渲染里只读现成的那一份 —— 渲染绝不等网络。
 */
export function useAgentIcon(id: string | undefined, enabled: boolean): string | undefined {
  const store = useAgentIconStore();
  const live = store !== undefined && id !== undefined && id !== '' && enabled;
  const url = useSyncExternalStore(
    (onChange) => (store === undefined ? () => {} : store.subscribe(onChange)),
    () => (live && store !== undefined && id !== undefined ? store.url(id) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (live && store !== undefined && id !== undefined) store.want(id);
  }, [live, store, id]);
  return url;
}

export interface AgentIconProps {
  /** 登记表条目的 id(有专门读法的那几家是 `claude` / `dsh`……,别的是包标识)。派活的家名、额度那一格的 id 就是它。 */
  agent: string;
  /** 从 `/state` 里认这一家(名字、颜色、有没有图都在登记表里)。缺席 = 只画色点。 */
  state?: Pick<WorkbenchState, 'agent_registry'> | undefined;
  size?: number;
  /**
   * 那颗状态点画成什么色(事项卡上原来那一颗)。给了就画:没有图时它**就是**原来那颗点,
   * 有图时它挪到图的右下角当角标。缺席 = 不画状态点(名字前只是一张图 / 一颗这一家的色点)。
   */
  dot?: CardDot | undefined;
  /**
   * 没有图时那颗点**涂成这个色**(卡 Q 的 `tint`:各家正在办的卡、会话详情抬头原来就是这么画的)。
   *
   * 为什么不直接拿登记表里的 `color`:**有 `dot` 的地方那颗点原来在报状态**(要你看的黄、等你确认的灰环……),
   * 一律涂成那一家的颜色等于把状态色吃掉了 —— 登记表那一档的卡就会从黄点变成灰点。
   * 所以规矩是:**`dot` 在的地方照旧**(只有原来就涂色的那两处显式传 `tint`);
   * 没有 `dot` 的那几处(派活确认点、额度那一页……本来就没有点)才退回这一家自己的颜色。
   */
  tint?: string | undefined;
}

export function AgentIcon({ agent, state, size = AGENT_ICON_SIZE, dot, tint }: AgentIconProps) {
  const entry = state?.agent_registry?.entries.find((one) => one.id === agent);
  const url = useAgentIcon(agent, entry?.icon === true);
  // 见 `tint` 那一段:有状态点的地方不拿这一家的颜色去盖它。
  const color = tint ?? (dot === undefined ? entry?.color : undefined);
  // 这张图画不出来(字节坏了、半截):**当场退回色点**,不留一块破图。
  const [broken, setBroken] = useState<string | undefined>(undefined);
  if (url === undefined || url === broken) {
    // 退回色点:与这张图不存在时一模一样的那一颗(有 dot 就是状态色,被这一家的颜色盖过)。
    return (
      <span
        className="ba-dot ba-agenticon__fallback"
        data-dot={dot ?? 'white'}
        style={color === undefined ? undefined : { background: color }}
        aria-hidden
      />
    );
  }
  return (
    <span className="ba-agenticon" style={{ width: `${size}px`, height: `${size}px` }}>
      <img className="ba-agenticon__img" src={url} alt="" aria-hidden width={size} height={size} onError={() => setBroken(url)} />
      {dot !== undefined && <i className="ba-agenticon__dot" data-dot={dot} aria-hidden />}
    </span>
  );
}
