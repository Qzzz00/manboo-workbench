'use strict';

// 音色目录的**标签**(2026-09-23,Ben 真机第二通:「怎么都是女的」)。
//
// 那一通的病根不是「库里只有三个」——`volcVoiceCatalog.json` 里躺着 99 个。
// 病根是**这 99 个身上什么都没写**:只有 id、名字、场景。于是工人只能按清单顺序取前三个,
// 而清单头上正好连着三个女声(知性灿灿 / 可爱女生 / 调皮公主),他一听就问「怎么都是女的」。
//
// 这个文件给每一条补上人能用的几格:性别、年龄感、风格、语言/口音、一句人话简介。
// 数据在 `voices-catalog.json`,**标签怎么来的写在那个文件的头上**(关键词表在
// `butler-server/scripts/tag-voices.mjs`):
//   · 性别取自火山自己的 id 命名(`_female_` / `_male_`),可靠;
//   · 年龄感与风格是**按名字和场景推的**,没有人逐个听过 —— 推不出来的一律写「未标」。
// **「未标」是一个真答案**:她在电话里就说「这个没标」,不编一个「温柔知性」出来。
//
// 目录里没有这条 id(复刻音色 S_/BV、或者换了供应商)→ 回 undefined,调用方照旧只给 id 和名字。

const CATALOG = require('./voices-catalog.json');

/** 标签缺席时统一写这两个字。与 voices-catalog.json 的 `untagged` 同一份。 */
const UNTAGGED = CATALOG.untagged || '未标';

const BY_ID = new Map(CATALOG.voices.map((v) => [v.id, v]));

/** 这份目录是给哪个供应商的。别家(dashscope / minimax)一律没有标签。 */
const CATALOG_PROVIDER = CATALOG.provider_type;

function normalizeType(providerType) {
  // volcengine_rtc 与 volcengine 共用 voice_type 命名空间(同 ttsVoices.voiceExists)。
  return providerType === 'volcengine_rtc' ? 'volcengine' : providerType;
}

/** 某条音色的标签。没有就 undefined —— **不编一份空标签**,调用方要分得出「没标」和「没这条」。 */
function tagsOf(providerType, voiceId) {
  if (normalizeType(providerType) !== CATALOG_PROVIDER) return undefined;
  const entry = BY_ID.get(String(voiceId || '').trim());
  if (!entry) return undefined;
  return {
    gender: entry.gender,
    age: entry.age,
    styles: entry.styles,
    accent: entry.accent,
    blurb: entry.blurb,
    // 可用性:在这台后端账号的导出清单里、且标着 supported。查不到的算「未验」。
    verified: entry.verified === true,
  };
}

/** 给一串 `{id,name,...}` 挨个贴上标签(贴不上的原样过)。 */
function decorate(providerType, voices) {
  return (voices || []).map((one) => {
    const tags = tagsOf(providerType, one.id);
    return tags === undefined ? { ...one, verified: false } : { ...one, ...tags };
  });
}

module.exports = {
  CATALOG,
  UNTAGGED,
  CATALOG_PROVIDER,
  tagsOf,
  decorate,
};
