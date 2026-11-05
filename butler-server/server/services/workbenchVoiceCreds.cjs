'use strict';

// 工作台(8791)下发的语音钥匙,**只在这台进程的内存里**(2026-09-23,本机版新写)。
//
// ## 为什么有这一层
//
// 从零重装的新机器登录后,8792 的 /api/tts 一律 503:这台服务以前只认 sqlite 里设置页手填的供应商,
// 而新用户从没填过、也不该去填(他不知道「火山」是什么)。与此同时,8791 登录后已经能凭设备令牌
// 向中转取回一份通道凭据(workbench-plugin/src/server/channelCredentials.ts),里头可以有 volc_tts / volc_asr。
// 这一层把那一份接过来,解析顺序变成:**sqlite 设置页(用户自己填的优先)→ 工作台下发 → 没有**
// (顺序本身在 voiceCredentials.cjs)。
//
// ## 交接方式:8792 向 8791 回环**拉**(不是 8791 推)
//
//   GET http://127.0.0.1:8791/channel/credentials —— 那条路由早就有(通话工人每轮进房前也问它),**只认回环**。
//
// 为什么选拉:
//   1. **重启自愈是白送的**。8792 重启 → 内存清空 → 下一次要用钥匙时自己去拉;8791 重启 → 它那边内存也清空,
//      我们手上这份到期前照用,到期再拉时 8791 已经重新取好了。推的话得回答「8792 刚重启、8791 不知道」
//      这一格,最后还是要补一条「8792 起来先拉一次」——那就只剩拉了。
//   2. **不新开口子**。拉的是一条现成的、只认回环的路由,8791 一行不改;推要在 8792 上新开一个
//      可写入钥匙的接口,多一个要守的门。
//   3. **不用 X-Workbench-Token**:那把令牌是 8791 → 8792 方向的;8791 那条路由认的是回环,我们本来就在回环上。
//
// ## 纪律
//
//   · 只在内存。不落盘、不进 sqlite、不进 /health、不进任何回包、不进日志(日志只写「有没有」)。
//   · 永不抛。取不到就说一句能行动的人话(ttsUnavailableMessage),调用方原样回给工人,工人原样进日志。
//   · 8791 暂时不在(网络错)时**手上那份照用**:钥匙没换,只是问不到;工作台重启那十几秒她不该哑。
//     8791 明确说「没有了」(退出登录 / 服务器撤了)才扔。
//   · 同一时刻只拉一次(工人开场白一次预合成好几句,会同时进来)。
//
// 开关:`BUTLER_WORKBENCH_URL` 改地址(灰度实例用);设成 `off` 整条关掉(测试默认关,见 vitest.config)。

const DEFAULT_WORKBENCH_URL = 'http://127.0.0.1:8791';
/** 8791 那一格没写到期时间时,多久重拉一次。与 channelCredentials.ts 的兜底同一个数。 */
const FALLBACK_TTL_MS = 5 * 60 * 1000;
/** 提前多久算过期。 */
const SKEW_MS = 30 * 1000;
/** 拉失败或「还没有」之后,多久内不再拉。新用户刚登录完,半分钟内就该跟上。 */
const RETRY_MS = 15 * 1000;
/**
 * 拉一次最多等多久。8791 那条路由背后可能要去外网问中转(它自己的超时是 8 秒),
 * 所以这里给得比它长一点,免得它刚取到我们就先放弃了。
 */
const FETCH_TIMEOUT_MS = 10 * 1000;

function text(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function workbenchUrl() {
  const raw = text(process.env.BUTLER_WORKBENCH_URL);
  if (raw === undefined) return DEFAULT_WORKBENCH_URL;
  if (['off', '0', 'false', 'no'].includes(raw.toLowerCase())) return undefined;
  return raw.replace(/\/+$/, '');
}

function volcOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  const appId = text(value.app_id);
  const accessToken = text(value.access_token);
  if (appId === undefined || accessToken === undefined) return undefined;
  return {
    appId,
    accessToken,
    ...(text(value.resource_id) === undefined ? {} : { resourceId: text(value.resource_id) }),
    ...(text(value.cluster) === undefined ? {} : { cluster: text(value.cluster) }),
  };
}

/**
 * 为什么「没有」。按它说人话:
 *   never          还没拉过(刚起来,或开关关了)
 *   workbench_down 连不上 8791
 *   workbench_old  8791 没有这条路由(老工作台)或回了看不懂的东西
 *   not_linked     8791 说它自己也没拿到(多半是还没登录)—— note 是它的原话
 *   server_missing 8791 拿到了,但服务器那边没配这一把
 */
function createStore({ fetchImpl, now = Date.now, log = (line) => console.log(line) } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  /** { volcTts?, volcAsr?, expiresAtMs } —— 最近一次拉成功的那一份。 */
  let held;
  /** 最近一次「没拿到」的原因;拉成功后清掉。 */
  let failure = { reason: 'never' };
  let nextTryAt = 0;
  let inflight;
  /** 上一行日志,同样的话不重复打(拉失败每 15 秒一次,别刷屏)。 */
  let lastLine = '';

  function say(line) {
    if (line === lastLine) return;
    lastLine = line;
    log(line);
  }

  function fresh() {
    return held !== undefined && now() + SKEW_MS < held.expiresAtMs;
  }

  async function pull() {
    const base = workbenchUrl();
    if (base === undefined) {
      failure = { reason: 'never' };
      nextTryAt = now() + RETRY_MS;
      return;
    }
    let res;
    try {
      res = await doFetch(`${base}/channel/credentials`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      // 手上那份照用(见文件头「纪律」第三条),只记原因。
      failure = { reason: 'workbench_down' };
      nextTryAt = now() + RETRY_MS;
      say('[butler-server] 工作台下发的语音钥匙:连不上工作台,等它起来再取');
      return;
    }
    let body;
    try { body = await res.json(); } catch { body = undefined; }
    if (!res.ok || !body || typeof body !== 'object') {
      failure = { reason: 'workbench_old' };
      nextTryAt = now() + RETRY_MS;
      say(`[butler-server] 工作台下发的语音钥匙:工作台回了 ${res.status},取不到`);
      return;
    }
    if (body.source !== 'server') {
      // 8791 明确说它手上没有:退出登录了,或者还没登录。**手上的扔掉**。
      held = undefined;
      failure = { reason: 'not_linked', note: text(body.note) };
      nextTryAt = now() + RETRY_MS;
      say('[butler-server] 工作台下发的语音钥匙:工作台还没从服务器拿到(多半是还没登录)');
      return;
    }
    const volcTts = volcOf(body.volc_tts);
    const volcAsr = volcOf(body.volc_asr);
    const at = text(body.expires_at) === undefined ? NaN : Date.parse(body.expires_at);
    const expiresAtMs = Number.isFinite(at) ? at : now() + FALLBACK_TTL_MS;
    held = {
      ...(volcTts === undefined ? {} : { volcTts }),
      ...(volcAsr === undefined ? {} : { volcAsr }),
      // 到期时间太近(或已过)也至少隔一个重试间隔再拉,免得每一句都去问一次。
      expiresAtMs: Math.max(expiresAtMs, now() + SKEW_MS + RETRY_MS),
    };
    failure = undefined;
    if (volcTts === undefined) {
      // 服务器那边补上之后要尽快跟上:没有 TTS 时按重试间隔再问,不按一小时的到期时间。
      held.expiresAtMs = Math.min(held.expiresAtMs, now() + SKEW_MS + RETRY_MS);
    }
    nextTryAt = 0;
    // **只写有没有,不写值**。
    say(`[butler-server] 工作台下发的语音钥匙:取到了(tts=${volcTts === undefined ? 0 : 1} asr=${volcAsr === undefined ? 0 : 1})`);
  }

  /**
   * 该拉就拉一次;手上这份还新鲜就立刻回。**永不抛**。
   * 回的是一份快照(没有密钥值的那部分由 current() 给)。
   */
  async function ensure() {
    if (fresh()) return;
    if (now() < nextTryAt) return;
    if (!inflight) {
      inflight = pull().catch(() => {
        failure = { reason: 'workbench_down' };
        nextTryAt = now() + RETRY_MS;
      }).finally(() => { inflight = undefined; });
    }
    await inflight;
  }

  /** 手上那份(可能已过期但 8791 暂时问不到 —— 那时照用)。 */
  function current() {
    return held;
  }

  /**
   * 为什么没有这一把(有的话 undefined)。8791 上一次答过话(held 在)却没给这一把 = 服务器那边没配;
   * 一次都没答上 = 看 failure。
   */
  function missingOf(key) {
    if (held && held[key]) return undefined;
    if (held) return { reason: 'server_missing' };
    return failure || { reason: 'never' };
  }

  /** 测试用。 */
  function reset() {
    held = undefined;
    failure = { reason: 'never' };
    nextTryAt = 0;
    inflight = undefined;
    lastLine = '';
  }

  return {
    ensure,
    current,
    ttsFailure: () => missingOf('volcTts'),
    asrFailure: () => missingOf('volcAsr'),
    reset,
  };
}

/**
 * 没有 TTS 钥匙时那句话。**能行动**:说清是谁的事、要不要他自己去设置里填(不用)。
 * 调用方原样放进 503 的 error,工人原样进日志(channel-worker 的 upstreamDetailOf)。
 */
function ttsUnavailableMessage(failure) {
  const reason = failure && failure.reason;
  switch (reason) {
    case 'server_missing':
      return '服务器还没下发语音合成的钥匙,她暂时开不了口(要维护者在服务器上补,不用自己去设置里填)。';
    case 'not_linked':
      return `服务器下发的语音合成钥匙还没拿到,她暂时开不了口。${failure.note || '登录之后会自己拿到。'}`;
    case 'workbench_down':
      return '连不上工作台,拿不到服务器下发的语音合成钥匙,她暂时开不了口;工作台起来后会自己恢复。';
    case 'workbench_old':
      return '工作台版本太旧,拿不到服务器下发的语音合成钥匙,她暂时开不了口;升级工作台后恢复。';
    default:
      return '还没拿到服务器下发的语音合成钥匙,她暂时开不了口;登录之后会自己拿到。';
  }
}

/** ASR 那一句。同一套分类,只是说的是「听」。 */
function asrUnavailableMessage(failure) {
  const reason = failure && failure.reason;
  switch (reason) {
    case 'server_missing':
      return '服务器还没下发语音识别的钥匙,她暂时听不懂(要维护者在服务器上补,不用自己去设置里填)。';
    case 'not_linked':
      return `服务器下发的语音识别钥匙还没拿到,她暂时听不懂。${failure.note || '登录之后会自己拿到。'}`;
    case 'workbench_down':
      return '连不上工作台,拿不到服务器下发的语音识别钥匙,她暂时听不懂;工作台起来后会自己恢复。';
    case 'workbench_old':
      return '工作台版本太旧,拿不到服务器下发的语音识别钥匙,她暂时听不懂;升级工作台后恢复。';
    default:
      return '还没拿到服务器下发的语音识别钥匙,她暂时听不懂;登录之后会自己拿到。';
  }
}

/** 进程里那一份。 */
const store = createStore();

module.exports = {
  createStore,
  store,
  ensure: () => store.ensure(),
  ttsUnavailableMessage,
  asrUnavailableMessage,
  workbenchUrl,
  FALLBACK_TTL_MS,
  RETRY_MS,
};
