/**
 * 需求卡要打的那五条接口(2026-09-23,中秋断点 A;第五条是同日「同一个事务官」加的)。
 *
 *   POST /feature/docs    { id }                      四个页签 + 把关记录 + 仓库路径,一次读回来
 *   POST /feature/run     { id, note? }               「让事务官推进这一步」
 *   POST /feature/review  { id, tab, action, text? }  把关三键 + 留痕
 *   POST /feature/record  { id }                      把结论追加进她仓库的决策记录
 *   POST /feature/ship    { id }                      ★ 合并 main 并发一版(2026-09-23)
 *
 * ★ **只对 `ApiClient` 说话**。局域网里这就是直连 8791,出了局域网同一个接口由
 * `channel/routedClient.ts` 换成经 LiveKit 房间让 Mac 上的工人代理 —— 这一层一个字都不用改,
 * 也不该知道自己走的是哪条路(session.ts 开头那段规矩)。
 *
 * ★ **手机不写长文**:这里**没有** `/feature/doc/save`。四个页签只读,「我自己改」只留痕,
 * 不在手机上打开编辑器。房间白名单里也照这条没放行那条路(channel-worker/src/rpc.ts)。
 *
 * ★ **需求名与仓库路径都不从这里传**:服务端自己按卡的标题与 `project_id` 去查。
 * 少一条"往哪儿写"的输入就少一把钥匙(交接-0922-需求卡指挥台 第四节)。
 */
import type { ApiClient, ApiResult } from '../api/client';
import type { FeatureDocsBody } from './deckProtocol';

/** 把关三键真正发出去的那三个 id。 */
export type FeatureReviewAction = 'pass' | 'revise' | 'self';

/**
 * `POST /feature/review` 的回包。
 *
 * `sent` = 「打回」那一句送进事务官的会话了没有;`note` 是没送出去时的那句原话。
 * **两件事分开**:留痕一定成了(服务端先留痕再送话),送没送出去是另一回事 ——
 * 糊成一句「失败」会让他以为这次把关没算数。通过 / 我自己改本来就不送话,`sent:false`。
 */
export interface FeatureReviewBody {
  ok: true;
  sent: boolean;
  note?: string;
}

/**
 * `POST /feature/run` 的回包。
 *
 * `standin` = 这一步该派出去的那几家派不出去(窗口编排壳没接上),事务官自己顶着做。
 * `text` 是交给事务官的那一整段话 —— **手机上不显示它**(几百字的提示词),只留着备查。
 */
export interface FeatureRunBody {
  ok: true;
  sent: boolean;
  stage?: string;
  standin?: boolean;
  text?: string;
  note?: string;
}

/**
 * ★ `POST /feature/ship` 的回包(2026-09-23)。**`ok` 在 body 里,不在 HTTP 状态里** ——
 * 那条闭环八步,停在第几步是**执行结果**不是接口出错,所以失败照旧 200 + `ok:false`
 * (与工作台那一侧 `/snap`、`/dispatch/client` 同一条老规矩)。
 *
 * `stopped_at` = 停在哪一步,`note` = 那一步的原话,`version` = 发出去的版本号。
 */
export interface FeatureShipBody {
  ok: boolean;
  stopped_at?: string;
  note?: string;
  version?: string;
  steps?: readonly unknown[];
}

/** `POST /feature/record` 的回包。`added:false` = 一模一样的一节已经在里面了。 */
export interface FeatureRecordBody {
  ok: true;
  path: string;
  added: boolean;
  log_note?: string;
}

export interface FeatureApi {
  docs(id: string): Promise<ApiResult<FeatureDocsBody>>;
  run(id: string, note?: string): Promise<ApiResult<FeatureRunBody>>;
  review(input: { id: string; tab: string; action: FeatureReviewAction; text?: string }): Promise<ApiResult<FeatureReviewBody>>;
  record(id: string): Promise<ApiResult<FeatureRecordBody>>;
  /**
   * ★ 发版(2026-09-23)。**只带 id** —— 那句"跟她说这一版是什么"的人话由服务端从
   * `需求.md` 的「目标」那一行取,取不到就 400 并如实说(它会原样显示在她的设置里,不能编)。
   * 手机上不打那段字。
   */
  ship(id: string): Promise<ApiResult<FeatureShipBody>>;
}

export function createFeatureApi(client: ApiClient): FeatureApi {
  const post = <T>(path: string, body: Record<string, unknown>): Promise<ApiResult<T>> =>
    client.json<T>(path, { method: 'POST', body });
  return {
    docs: (id) => post<FeatureDocsBody>('/feature/docs', { id }),
    run: (id, note) => post<FeatureRunBody>('/feature/run', {
      id,
      // 空的一句话不发过去:服务端会把它当成"他什么都没补",发一个空串只是噪音。
      ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
    }),
    review: ({ id, tab, action, text }) => post<FeatureReviewBody>('/feature/review', {
      id,
      tab,
      action,
      ...(text === undefined || text.trim() === '' ? {} : { text: text.trim() }),
    }),
    record: (id) => post<FeatureRecordBody>('/feature/record', { id }),
    ship: (id) => post<FeatureShipBody>('/feature/ship', { id }),
  };
}
