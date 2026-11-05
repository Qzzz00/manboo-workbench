'use strict';

// 火山 TTS 的报错 → **一句人话 + 一条能照着做的动作**(2026-09-27,卡 VO 第 ③ 件)。
//
// 为什么要这一层:她在电话里合不出声时,工人只会说「语音后端这会儿有点问题」,
// 而真因躺在 8792 的 stderr 里,长这样:
//
//     volcengine TTS HTTP 403 [resource_id=volc.tts.default] requested resource not granted
//     volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency
//     volcengine TTS HTTP 200 code=45000292 quota exceeded for types: text_words_lifetime
//     volcengine TTS HTTP 400 code=3011 TTSInvalidText:unsupported language
//
// 这是**四件完全不同的事**:没开通 / 太挤 / 字数用完 / 这个嗓子念不了这段字。
// 把它们一律说成「有点问题」,她说了等于没说(2026-09-26 那次就是这么卡了一整天,
// 见决策记录 18:20 那条)。
//
// ## 纪律
//
//   · **只认得出来的才翻**。表里没有的码一律 kind='unknown',human 照抄上游原话,
//     **不编一个意思**(与 channel-worker/src/asr/volcProtocol.ts 的 ASR 码表同一条规矩)。
//   · 判断**先看话再看码**。火山同一句 message 在新旧两版接口上码不一样
//     (`quota exceeded for types: concurrency` 老版是 3001、新版是 45000000,
//     见 docs/交接-0920-引导通话第二轮.md 第 ② 节),message 才是稳的那一头。
//   · 输入是**已经 redact 过的**上游原话(voiceCredentials.redact)。这一层不碰密钥,
//     入参也不再写进任何日志。
//
// 码与原话的出处(2026-09-27 逐条核过,详见 docs/交接-0927-音色列表按账号实取.md 第一节):
//   · V1(3xxx)返回码表与「常见错误返回说明」 https://www.volcengine.com/docs/6561/1257584
//     —— `3001 无效请求 / 3003 并发超限 / 3005 后端服务忙 / 3010 文本超长 / 3011 无效文本
//        (含「文本与语种不匹配」)/ 3050 音色不存在`,以及逐字那几句:
//        `quota exceeded for types: xxx_lifetime`(试用用量用完,要开正式版)、
//        `extract request resource id: get resource id: access denied`(正式版开了但**没买这个音色**)、
//        `authenticate request: load grant: requested grant not found`(appid/token 不对)。
//   · 大模型 TTS 错误码总表 https://docs.volcengine.com/docs/DoubaoVoice/error-code-query-1?lang=zh
//     —— `45000000 speaker permission denied: get resource id: access denied`(音色没授权)、
//        `55000000 resource ID is mismatched with speaker related resource`(这一档下没有这个音色,
//        官方排查第一条就是「服务是否未开通」)、`45002000 TTS invalid speaker`。
//   · `3011 TTSInvalidText:unsupported language` 与 `3001 … concurrency` 另有**本机实收原话**
//     (09-27 实取 / 09-20 那一通)。
//   · `45000292` 只在实收报文里见过,官方现行页面查不到(原出处「异步长文本接口」已下线)——
//     按 message 里的 `*_lifetime` 判它是额度,**不靠那个码**。

/** 这一类错误意味着「这个音色/这一档这个账号根本用不了」——实取时据此把它划掉。 */
const UNAVAILABLE_KINDS = new Set(['not_granted', 'quota', 'no_such_voice']);
/**
 * 这一类是「这会儿不行 / 这次问法不对」——实取时**绝不能**据此把音色划掉,
 * 只能记一句「这次没问出来」。把 busy 当成「没开通」会在她挑音色时凭空少掉半张表。
 */
const INCONCLUSIVE_KINDS = new Set(['busy', 'network', 'text_rejected', 'bad_request', 'auth', 'unknown']);

/** 从原话里抠出火山的错误码。抠不到回 undefined,**不猜**。 */
function codeOf(message) {
  const text = String(message == null ? '' : message);
  const tagged = text.match(/\bcode[=:\s]+(\d{3,8})\b/i);
  if (tagged) return Number(tagged[1]);
  // 没有 `code=` 前缀时只认那几个长码(45xxxxxx / 55xxxxxx),免得把 HTTP 状态码当成业务码。
  const bare = text.match(/\b((?:45|55)\d{6})\b/);
  return bare ? Number(bare[1]) : undefined;
}

/** HTTP 状态码(上游原话里那个 `HTTP 403`)。 */
function httpStatusOf(message) {
  const m = String(message == null ? '' : message).match(/\bHTTP\s+(\d{3})\b/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * 认得出来的几类。**顺序有意义**:先匹配到的赢。
 * pattern 匹配上游原话;codes 是补充(原话被截断时还认得出)。
 */
const RULES = [
  {
    kind: 'not_granted',
    pattern: /requested resource not granted|resource not granted|not granted|permission denied|access denied|resource ID is mismatched|未开通|无权限|no permission/i,
    human: '这个音色(或它所在的那一档语音合成)这个火山账号没开通 / 没买',
    action: '去火山引擎控制台「语音技术 → 语音合成大模型」把对应那一档(1.0 字符版 / 2.0 Seed-TTS)开通,再在音色列表里给这个音色下一单(标着免费的也要下 0 元单);开完这台不用重启,下一句就有声音',
  },
  {
    // 这一条要排在通用 quota 前面:它的 message 里也有 "quota exceeded"。
    kind: 'busy',
    pattern: /quota exceeded for types:\s*concurrency|concurrency limit|并发/i,
    codes: [3001, 45000000],
    human: '同一时刻合成的句子太多,撞上了火山的并发上限',
    action: '等一下就好;老这样就去火山控制台把并发配额调高',
  },
  {
    kind: 'quota',
    pattern: /quota exceeded|text_words|字数用完|余额不足|insufficient balance|arrearage|欠费/i,
    codes: [45000292],
    human: '这一档语音合成的额度(字数 / 余额)用完了',
    action: '去火山引擎控制台「语音技术 → 语音合成大模型」续费,或换一档已经买了的;换完这台不用重启',
  },
  {
    // 09-27 实取时英文音色念中文那句探针收到的就是它:音色**是开通的**,只是这段字它不念。
    kind: 'text_rejected',
    pattern: /TTSInvalidText|unsupported language|invalid text/i,
    codes: [3011],
    human: '这个音色念不了这段文字(多半是语种对不上,比如拿中文去喂英文音色)',
    action: '换一段这个音色的语种的文字再试;这不代表音色没开通',
  },
  {
    // 3050「音色不存在」/ 45000001 `speaker not found` / 45002000 `TTS invalid speaker`。
    // 对「这个音色能不能用」来说,它和「没开通」是同一个结论:换不成。
    kind: 'no_such_voice',
    pattern: /speaker not found|invalid speaker|音色不存在|speaker S_\w+ not found/i,
    codes: [3050, 45002000],
    human: '火山说没有这个音色(id 写错了,或者这一档下面根本没有它)',
    action: '在火山控制台的音色列表里核对一下 id;要是复刻音色,看看是不是过期了',
  },
  {
    kind: 'auth',
    pattern: /invalid token|token invalid|requested grant not found|load grant|authenticate|unauthorized|signature|鉴权|签名/i,
    human: '火山不认这把钥匙(appid / access token 对不上)',
    action: '去工作台设置里重新登录一次,或在火山控制台确认这个应用的 access token 没被换掉',
  },
  {
    kind: 'busy',
    pattern: /server busy|服务器繁忙|service unavailable|overload/i,
    codes: [3005, 55000031],
    human: '火山那边这会儿忙不过来',
    action: '等一下重试;这不是我们这头的毛病',
  },
  {
    kind: 'bad_request',
    pattern: /invalid request|参数无效|invalid parameter|missing required|Init Engine Instance failed/i,
    codes: [3003, 45000001, 45000002, 45000151],
    human: '发给火山的请求它看不懂(参数不对)',
    action: '这是我们这头的毛病,把 8792 的这一行日志交给统筹会话',
  },
  {
    kind: 'network',
    pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|aborted|timeout|超时/i,
    human: '连不上火山(网络断了或超时)',
    action: '看一眼这台机器的网;网通了下一句自己就有声音',
  },
];

/**
 * 上游原话 → `{ kind, code?, human, action?, detail }`。
 *
 * `human` 是**说给人听的那一句**;`action` 是接下来该做什么(认不出来时没有这一格)。
 * `detail` 永远是传进来的那句原话(已经 redact 过),留着进日志 —— 人话是给她说的,
 * 原话是给查的人看的,两个都不能丢。
 */
function explain(message) {
  const detail = String(message == null ? '' : message).trim();
  const code = codeOf(detail);
  const status = httpStatusOf(detail);
  for (const rule of RULES) {
    const byText = rule.pattern.test(detail);
    const byCode = code !== undefined && Array.isArray(rule.codes) && rule.codes.includes(code);
    if (byText || byCode) {
      return { kind: rule.kind, ...(code === undefined ? {} : { code }), human: rule.human, action: rule.action, detail };
    }
  }
  // 文字与码都认不出,但 HTTP 403 本身就说明「这个账号不让用这个」——这一格是有把握的。
  if (status === 403) {
    return { kind: 'not_granted', ...(code === undefined ? {} : { code }), human: RULES[0].human, action: RULES[0].action, detail };
  }
  if (status === 429) {
    return { kind: 'busy', ...(code === undefined ? {} : { code }), human: RULES[1].human, action: RULES[1].action, detail };
  }
  // 认不出来:如实说认不出来,**原话照抄**,不编一个意思。
  return {
    kind: 'unknown',
    ...(code === undefined ? {} : { code }),
    human: detail === '' ? '火山那边没说原因' : `火山回了一句我看不懂的:${detail}`,
    detail,
  };
}

/** 说给人听的那一句(人话 + 该做什么)。日志与字幕都用它。 */
function humanLine(message) {
  const e = explain(message);
  return e.action === undefined ? e.human : `${e.human} —— ${e.action}`;
}

/** 这条报错是不是「这个音色这个账号用不了」(实取时据此划掉)。 */
function meansUnavailable(message) {
  return UNAVAILABLE_KINDS.has(explain(message).kind);
}

/** 这条报错是不是「这次没问出来」(实取时**不许**据此划掉)。 */
function meansInconclusive(message) {
  return INCONCLUSIVE_KINDS.has(explain(message).kind);
}

module.exports = {
  explain,
  humanLine,
  meansUnavailable,
  meansInconclusive,
  codeOf,
  UNAVAILABLE_KINDS,
  INCONCLUSIVE_KINDS,
};
