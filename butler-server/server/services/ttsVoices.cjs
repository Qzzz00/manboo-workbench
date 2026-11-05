'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/ttsVoices.cjs
// 官方音色「精选清单」（维护用）。各厂商无统一「列全部官方音色」API，这里维护常用项；
// 完整列表以各自官方文档为准。复刻音色不在此（走账号查询）。

// 火山「大模型语音合成(SeedTTS)」公版音色**候选目录**(见 volcVoiceCatalog.json)。
//
// ⚠️ 2026-09-27 起这一份只是**候选**,不是「这个账号能用的」。
//    「这个账号真能用哪些」由 services/voiceAvailability.cjs **向火山实取**
//    (火山没有列已开通音色的接口,所以逐个试合一句极短文本),
//    路由回包前一律过一道 voiceAvailability.applyTo。
//    这里的 `supported` 字段只表示「值得去试一下」,**不表示已开通**。
// ⚠️ 必须是账号已开通的大模型音色；传统 BV*_streaming 属于另一套产品(语音技术)，
//    大模型账号调用会返回 403 [resource_id=volc.tts.default] requested resource not granted。
// 每条形如 { id, name, lang, scene, supported }。saturn 系(_tob)角色扮演音色走 V3 接口
// (volcengine.synthesizeV3，resource=seed-tts-2.0)，公版/复刻走 V1，目前全部可用。
const VOLC_VOICE_CATALOG = require('./volcVoiceCatalog.json');

// 对外只暴露「可用」音色（带 lang/scene 供后台分组下拉）。
const VOLC_OFFICIAL_VOICES = VOLC_VOICE_CATALOG
  .filter((v) => v.supported)
  .map((v) => ({ id: v.id, name: v.name, lang: v.lang, scene: v.scene }));

// 大模型默认音色：voice 为空 / dashscope 音色 / 遗留传统 BV* 时回退到它。
const DEFAULT_VOLC_VOICE = 'zh_female_vv_uranus_bigtts';

// DashScope qwen3-tts 常用音色（与 admin-ui defaults.QWEN_TTS_VOICES 对应）。
const DASHSCOPE_OFFICIAL_VOICES = [
  'Bunny',
  'Cherry',
  'Ethan',
  'Serena',
  'Chelsie',
  'Dylan',
  'Jada',
  'Sunny',
].map((v) => ({ id: v, name: v }));

// MiniMax 系统音色（官方 system-voice-id 清单的中文常用精选；完整见
// https://platform.minimaxi.com/docs/faq/system-voice-id）。账号自训复刻音色不在此列，
// 需填到 provider「默认音色」或角色音色框（resolveMinimaxVoice 对未知 id 会回落默认）。
const MINIMAX_OFFICIAL_VOICES = [
  { id: 'Chinese (Mandarin)_Radio_Host', name: '电台男主播' },
  { id: 'Chinese (Mandarin)_Lyrical_Voice', name: '抒情男声' },
  { id: 'Chinese (Mandarin)_Gentleman', name: '温润男声' },
  { id: 'Chinese (Mandarin)_Gentle_Youth', name: '温润青年' },
  { id: 'Chinese (Mandarin)_Sincere_Adult', name: '真诚青年' },
  { id: 'Chinese (Mandarin)_Reliable_Executive', name: '沉稳高管' },
  { id: 'Chinese (Mandarin)_Southern_Young_Man', name: '南方小哥' },
  { id: 'Chinese (Mandarin)_Unrestrained_Young_Man', name: '不羁青年' },
  { id: 'Chinese (Mandarin)_Warm_Bestie', name: '温暖闺蜜' },
  { id: 'Chinese (Mandarin)_Warm_Girl', name: '温暖少女' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', name: '甜美女声' },
  { id: 'Chinese (Mandarin)_Wise_Women', name: '阅历姐姐' },
  { id: 'Chinese (Mandarin)_Gentle_Senior', name: '温柔学姐' },
  { id: 'Chinese (Mandarin)_Mature_Woman', name: '傲娇御姐' },
  { id: 'Chinese (Mandarin)_Soft_Girl', name: '柔和少女' },
  // 传统基础音色
  { id: 'male-qn-jingying', name: '精英青年' },
  { id: 'male-qn-qingse', name: '青涩青年' },
  { id: 'male-qn-daxuesheng', name: '青年大学生' },
  { id: 'female-yujie', name: '御姐' },
  { id: 'female-chengshu', name: '成熟女性' },
  { id: 'female-tianmei', name: '甜美女性' },
  { id: 'female-shaonv', name: '少女' },
];

const MINIMAX_VOICE_IDS = new Set(MINIMAX_OFFICIAL_VOICES.map((v) => v.id));

// 判断 voice 是否属于 MiniMax 命名空间——切到 MiniMax 后用于忽略遗留的火山音色 id。
function isMinimaxVoice(id) {
  return MINIMAX_VOICE_IDS.has(String(id || '').trim());
}

// 火山复刻音色 speaker_id（S_xxx）与传统 BV* 音色是账号级、无法静态枚举，但属于
// 火山 voice_type 命名空间（见 volcengine.cjs/volcengineRtc.cjs 的 isCloned 逻辑）。
const VOLC_CLONED_RE = /^(S_|BV)/i;

// 判断某 provider_type 下 voice_id 是否属于已知音色命名空间。
// 官方音色按目录精确匹配；火山复刻(S_/BV)走命名空间约定（账号级，无本地全量）。
// volcengine_rtc 与 volcengine 共用 voice_type 命名空间。
function voiceExists(providerType, voiceId) {
  const v = String(voiceId || '').trim();
  if (!v) return false;
  const type = providerType === 'volcengine_rtc' ? 'volcengine' : providerType;
  if (officialVoices(type).some((o) => o.id === v)) return true;
  if (type === 'volcengine' && VOLC_CLONED_RE.test(v)) return true;
  return false;
}

const OFFICIAL_BY_TYPE = {
  volcengine: VOLC_OFFICIAL_VOICES,
  dashscope: DASHSCOPE_OFFICIAL_VOICES,
  minimax: MINIMAX_OFFICIAL_VOICES,
};

function officialVoices(providerType) {
  return OFFICIAL_BY_TYPE[providerType] || [];
}

module.exports = {
  VOLC_VOICE_CATALOG,
  VOLC_OFFICIAL_VOICES,
  DEFAULT_VOLC_VOICE,
  DASHSCOPE_OFFICIAL_VOICES,
  MINIMAX_OFFICIAL_VOICES,
  isMinimaxVoice,
  officialVoices,
  voiceExists,
};
