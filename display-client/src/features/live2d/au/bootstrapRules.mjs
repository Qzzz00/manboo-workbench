// 纯函数：bootstrap-au-profiles 脚本与 vitest 单测共享的映射/播种规则。
// 无 IO、无依赖，方便单测；脚本 (scripts/bootstrap-au-profiles.mjs) 与
// 单测 (bootstrapRules.test.ts) 同时 import 本文件，保证「唯一事实源」。
//
// 情绪枚举沿用 Aiboo 现有 8 个（src/lib/emotion.ts EMOTIONS），不引入 Ekman 7。

/** Aiboo 合法情绪（与 src/lib/emotion.ts EMOTIONS 对齐）。 */
export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'gentle',
  'excited',
];

/** 全部 SemanticAction（与 au/types.ts SEMANTIC_ACTIONS 对齐）。 */
export const SEMANTIC_ACTIONS = [
  'brow.height',
  'brow.height.left',
  'brow.height.right',
  'eye.open',
  'eye.open.left',
  'eye.open.right',
  'eye.gaze.x',
  'eye.gaze.y',
  'mouth.open',
  'mouth.smile',
  'mouth.x',
  'mouth.y',
  'head.yaw',
  'head.pitch',
  'head.roll',
];

/** SemanticAction → FacialRegion。 */
export function actionRegion(action) {
  if (action.startsWith('brow')) return 'brow';
  if (action.startsWith('eye')) return 'eye';
  if (action.startsWith('mouth')) return 'mouth';
  if (action.startsWith('head')) return 'head';
  return undefined;
}

// ── 参数名 → SemanticAction 映射表 ────────────────────────────────────────
// 标准 Live2D 命名（Cubism 默认 ParamId）。按正则匹配，大小写不敏感。
// 顺序即优先级：靠前的规则先命中（用于多参数指向同一 action 的去重）。
// 说明：EyeLSmile/EyeRSmile 是「眯眼笑」，没有独立 SemanticAction，
//       归到 mouth.smile 作辅助（笑容整体的一部分）。
// 命名变体：L/R 可在词中（ParamEyeLOpen）或词尾（ParamEyeOpenL）。
// 眉毛高度只认 Y/height（ParamBrowLY 或 ParamBrowYL），不认 X/Form/Angle。
export const PARAM_ACTION_RULES = [
  { re: /^parameye(l|left)open$|^parameyeopen(l|left)$/i, action: 'eye.open.left' },
  { re: /^parameye(r|right)open$|^parameyeopen(r|right)$/i, action: 'eye.open.right' },
  { re: /^parameyeballx$/i, action: 'eye.gaze.x' },
  { re: /^parameyebally$/i, action: 'eye.gaze.y' },
  { re: /^parammouthopeny$/i, action: 'mouth.open' },
  { re: /^parammouthform$/i, action: 'mouth.smile' },
  { re: /^parammouthx$/i, action: 'mouth.x' },
  { re: /^parammouthy$/i, action: 'mouth.y' },
  // 眯眼笑辅助 → mouth.smile（auxiliary：主参 ParamMouthForm 存在时优先用主参，
  // 与参数清单顺序无关）
  { re: /^parameye[lr]smile$|^parameyesmile[lr]$/i, action: 'mouth.smile', auxiliary: true },
  // 眉高：ParamBrowLY / ParamBrowYL（仅 Y/height，排除 BrowX/BrowForm/BrowAngle）
  { re: /^parambrowl?y$|^parambrowyl$/i, action: 'brow.height.left' },
  { re: /^parambrowr?y$|^parambrowyr$/i, action: 'brow.height.right' },
  // ParamAngleX/Y/Z = 头部偏航/俯仰/翻滚（身体用 ParamBodyAngle*，不在此）
  { re: /^paramanglex$/i, action: 'head.yaw' },
  { re: /^paramangley$/i, action: 'head.pitch' },
  { re: /^paramanglez$/i, action: 'head.roll' },
];

/** 参数名 → 命中规则（含 action 与 auxiliary 标记）；未命中返回 null。 */
function matchParamRule(paramName) {
  if (typeof paramName !== 'string') return null;
  const name = paramName.trim();
  for (const rule of PARAM_ACTION_RULES) {
    if (rule.re.test(name)) return rule;
  }
  return null;
}

/** 参数名 → SemanticAction；未命中返回 null（物理/身体/数字枚举参数跳过）。 */
export function paramNameToSemanticAction(paramName) {
  return matchParamRule(paramName)?.action ?? null;
}

/**
 * 参数名清单 → semanticBindings（Record<SemanticAction, {paramId,curve}>）。
 * 同一 action 被多个参数命中时保留首个（确定性，与 PARAM_ACTION_RULES 顺序无关，
 * 取决于参数清单顺序，故 model3 参数清单稳定即结果稳定）。
 */
export function buildSemanticBindings(paramNames) {
  const bindings = {};
  const auxOnly = new Set(); // 当前绑定来自 auxiliary 规则，允许被主规则顶替
  for (const name of paramNames || []) {
    const rule = matchParamRule(name);
    if (!rule) continue;
    const { action, auxiliary } = rule;
    if (bindings[action]) {
      // 已有绑定：仅当现有是 aux 且新的是主参时才顶替
      if (auxOnly.has(action) && !auxiliary) {
        bindings[action] = { paramId: name, curve: 'linear' };
        auxOnly.delete(action);
      }
      continue;
    }
    bindings[action] = { paramId: name, curve: 'linear' };
    if (auxiliary) auxOnly.add(action);
  }
  return bindings;
}

// ── exp3 文件名分类：emotion / apparel / morph / gesture ──────────────────
// 形态/服饰/一次性动作类 exp3 属②③④层，不当情绪 AU 播种（避免污染①情绪层）。
// 关键词表同时含「英文 + 中文 + 拼音」，子串匹配、大小写不敏感（base 已 toLowerCase；
// 中文字符 toLowerCase 后不变，靠 base.includes 命中；英文/拼音同时走 token 与子串）。
const MORPH_KEYWORDS = [
  // 英文
  'small',
  'smaller',
  'giant',
  'big',
  'chibi',
  'tall',
  'grow',
  'shrink',
  // 中文
  '变小',
  '变大',
  '缩小',
  '放大',
  '小孩',
  '正太',
  '萝莉',
  '幼态',
  // 拼音
  'bianxiao',
  'bianda',
  'suoxiao',
  'fangda',
  'xiaohai',
  'zhengtai',
  'luoli',
];
const APPAREL_KEYWORDS = [
  // 英文
  'hat',
  'cat',
  'dog',
  'ear',
  'ears',
  'tail',
  'glasses',
  'mask',
  'hairstyle',
  'hair',
  'headband',
  'headphone',
  'headset',
  'silly_hair',
  'pupil',
  'discoloration',
  'pet',
  'coat',
  'jacket',
  'outfit',
  'costume',
  'clothes',
  // 中文：发型/头发
  '短发',
  '长发',
  '发型',
  '头发',
  '马尾',
  '丸子头',
  // 中文：配饰/换装/衣物
  '眼罩',
  '帽',
  '眼镜',
  '墨镜',
  '猫耳',
  '兽耳',
  '兔耳',
  '耳朵',
  '外套',
  '换装',
  '衣',
  '裙',
  '丝袜',
  '白丝',
  '黑丝',
  '头纱',
  '头饰',
  '小狗', // 漂浮小狗等宠物装饰（避免用裸「猫」误伤「猫猫嘴」这类口型表情）
  '娃娃', // 抱娃娃等手持道具装饰
  'baowawa',
  // 拼音
  'duanfa',
  'changfa',
  'faxing',
  'toufa',
  'mawei',
  'yanzhao',
  'maozi',
  'yanjing',
  'mojing',
  'maoer',
  'shouer',
  'tuer',
  'erduo',
  'waitao',
  'huanzhuang',
  'qunzi',
  'siwa',
  'baisi',
  'heisi',
  'tousi', // 头丝 / 头纱
  'toushi',
];
// ④ gesture：一次性动作/姿态（抬手/拿话筒/俯身/按键/挥手/点头等），与服饰/形态一样
// 不参与情绪标注（emotions:{}）。同样含 英文 + 中文 + 拼音。
const GESTURE_KEYWORDS = [
  // 英文
  'wave',
  'point',
  'raise_hand',
  'mic',
  'microphone',
  'bow',
  'press',
  'nod',
  'gesture',
  'pose',
  'sing',
  // 中文
  '抬手',
  '举手',
  '挥手',
  '拿话筒',
  '话筒',
  '麦克风',
  '俯身',
  '弯腰',
  '按键',
  '点头',
  '比心',
  '敬礼',
  '唱歌',
  // 拼音
  'taishou',
  'jushou',
  'huishou',
  'nahuatong',
  'huatong',
  'maikefeng',
  'fushen',
  'wanyao',
  'anjian',
  'diantou',
  'bixin',
  'jingli',
  'changge',
];

/** 取路径基础名（容忍 'exp/19.exp3.json' 这类含子目录的引用）。 */
function fileBase(fileName) {
  const s = String(fileName);
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** 去掉路径与 .exp3.json 后缀，返回小写基础名。 */
export function exp3BaseName(fileName) {
  return fileBase(fileName)
    .replace(/\.exp3\.json$/i, '')
    .trim()
    .toLowerCase();
}

/** exp3 文件名 → 'morph' | 'apparel' | 'gesture' | 'emotion'。 */
export function classifyExp3(fileName) {
  const base = exp3BaseName(fileName);
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (kw) => tokens.includes(kw) || base.includes(kw);
  // 优先级：morph（含 small 等）> apparel > gesture > emotion。
  if (MORPH_KEYWORDS.some(has)) return 'morph';
  if (APPAREL_KEYWORDS.some(has)) return 'apparel';
  if (GESTURE_KEYWORDS.some(has)) return 'gesture';
  return 'emotion';
}

// ── exp3 文件名 → 情绪播种 ────────────────────────────────────────────────
// 按文件名子串命中（优先级从上到下）。仅对 emotion 类 exp3 调用。
// 命不中给 {neutral:0.3} 占位，待人工在 admin-ui 调整。
// 规则同时含「英文 + 中文 + 拼音」，子串匹配、大小写不敏感。
// 顺序即优先级：先匹配「弱信号 0.6」的具体词（如 黑脸→angry:0.6、爱心→happy:0.6），
// 避免被后面更宽的 0.8 规则吞掉。
const EMOTION_SEED_RULES = [
  // —— 弱信号（0.6）：必须排在对应强情绪之前，避免被 0.8 规则吞掉 ——
  // 爱心眼/爱心 → happy:0.6（aixin）
  { re: /爱心|aixin/, emotions: { happy: 0.6 } },
  // 黑脸 → angry:0.6（heilian）：脸黑/沉脸的轻怒，区别于「生气/怒」的 0.8
  { re: /黑脸|heilian/, emotions: { angry: 0.6 } },
  // 眨眼/挤眼/微笑 → happy:0.6（zhayan/jiyan/weixiao）
  { re: /眨眼|挤眼|微笑|zhayan|jiyan|weixiao/, emotions: { happy: 0.6 } },

  // —— 强信号（0.8 / 0.7）——
  // 开心/笑/高兴 → happy:0.8（kaixin/xiao/gaoxing）
  { re: /happy|joy|laugh|grin|开心|高兴|大笑|笑|kaixin|gaoxing|daxiao|xiao/, emotions: { happy: 0.8 } },
  // 生气/怒/愤怒 → angry:0.8（shengqi/nu/fennu）
  { re: /angry|anger|mad|rage|生气|愤怒|发怒|怒|shengqi|fennu|fanu/, emotions: { angry: 0.8 } },
  // 哭/泪汪汪/眼泪/泪/伤心/难过 → sad:0.8（ku/yanlei/leiwangwang/shangxin）
  {
    re: /cry|sad|tear|sob|depress|哭|泪汪汪|眼泪|泪|伤心|难过|yanlei|leiwangwang|shangxin|nanguo/,
    emotions: { sad: 0.8 },
  },
  // 兴奋 → excited:0.8（xingfen）
  { re: /excit|hyper|energetic|兴奋|嗨|xingfen/, emotions: { excited: 0.8 } },
  // 惊讶/吃惊/星星眼/星星 → surprised:0.8（jingya/chijing/xingxing）
  {
    re: /surpris|shock|stars|star|astonish|惊讶|吃惊|震惊|星星|jingya|chijing|zhenjing|xingxing/,
    emotions: { surprised: 0.8 },
  },
  // 害羞/脸红 → shy:0.7（haixiu/lianhong）
  { re: /shy|blush|bashful|害羞|脸红|羞|haixiu|lianhong/, emotions: { shy: 0.7 } },
  // 温柔/平静 → gentle:0.7（wenrou）
  { re: /gentle|calm|soft|warm|tender|温柔|平静|温和|wenrou|pingjing|wenhe/, emotions: { gentle: 0.7 } },

  // —— 较弱的正向线索：微笑/爱意（英文）——
  { re: /wink|smile|smiling|loving|love|heart/, emotions: { happy: 0.6 } },
];

/** exp3 文件名 → 情绪相关性（Record<Emotion, number>），命不中 {neutral:0.3}。 */
export function seedEmotionsForExp3(fileName) {
  const base = exp3BaseName(fileName);
  for (const { re, emotions } of EMOTION_SEED_RULES) {
    if (re.test(base)) return { ...emotions };
  }
  return { neutral: 0.3 };
}

/** 把 exp3 touch 的参数名清单推导成涉及的 FacialRegion 数组（去重、稳定顺序）。 */
export function regionsFromParams(paramNames) {
  const order = ['brow', 'eye', 'mouth', 'head'];
  const set = new Set();
  for (const name of paramNames || []) {
    const action = paramNameToSemanticAction(name);
    if (!action) continue;
    const region = actionRegion(action);
    if (region) set.add(region);
  }
  return order.filter((r) => set.has(r));
}

/**
 * 单个 exp3 文件 → NativeExpressionUnit（plain JSON）。
 * @param fileName exp3 文件名（如 'angry.exp3.json'）
 * @param touchedParams exp3 内 Parameters 的 Id 清单（用于 region 推导）
 */
export function exp3FileToNativeUnit(fileName, touchedParams = []) {
  const base = exp3BaseName(fileName);
  const regions = regionsFromParams(touchedParams);
  let category = classifyExp3(fileName);

  // 防御：名字没认出情绪（落 {neutral:0.3} 占位）且不碰任何标准面部参数的 exp3，
  // 几乎必然是「自定义参数开关」(服饰/姿势/形态/道具，如 rattan 的 Param84-127)，不是表情。
  // 若仍当 emotion 播种 neutral:0.3，solver 会把它当中性情绪挑中 → 触发非面部参数 →
  // 模型移动/消失/乱变（rattan「向下移动消失」即此）。统一归 'prop'，排除出 ① 情绪 solver。
  if (category === 'emotion' && regions.length === 0) {
    const seed = seedEmotionsForExp3(fileName);
    const isPlaceholder = seed.neutral === 0.3 && Object.keys(seed).length === 1;
    if (isPlaceholder) category = 'prop';
  }

  const isEmotion = category === 'emotion';
  const unit = {
    id: `native:${base}`,
    nativeRef: fileName,
    regions,
    emotions: isEmotion ? seedEmotionsForExp3(fileName) : {},
  };
  // 仅 apparel/morph/gesture/prop 标 category；情绪类不标（保持精简）
  if (!isEmotion) unit.category = category;
  return unit;
}

// 标准 FACS 情绪 → 语义动作目标值（base action）。neutral 不生成单元（缺省即中性）。
// 只用安全的标准面部动作，绝不含 head.*（头部位置）/身体参数，避免模型移动消失。
const EMOTION_AU = {
  happy: { 'mouth.smile': 0.8, 'eye.open': 0.6, 'brow.height': 0.1 },
  sad: { 'mouth.smile': -0.5, 'brow.height': -0.5, 'eye.gaze.y': -0.3 },
  angry: { 'brow.height': -0.8, 'mouth.smile': -0.3, 'eye.open': 0.85 },
  surprised: { 'brow.height': 0.8, 'eye.open': 1.0, 'mouth.open': 0.6 },
  shy: { 'mouth.smile': 0.35, 'brow.height': 0.2, 'eye.gaze.y': -0.4, 'eye.open': 0.7 },
  gentle: { 'mouth.smile': 0.45, 'eye.open': 0.7, 'brow.height': 0.1 },
  excited: { 'mouth.smile': 0.9, 'mouth.open': 0.45, 'eye.open': 0.95, 'brow.height': 0.3 },
};

const ACTION_RANGE = {
  'brow.height': [-1, 1], 'brow.height.left': [-1, 1], 'brow.height.right': [-1, 1],
  'eye.open': [0, 1], 'eye.open.left': [0, 1], 'eye.open.right': [0, 1],
  'eye.gaze.x': [-1, 1], 'eye.gaze.y': [-1, 1],
  'mouth.open': [0, 1], 'mouth.smile': [-1, 1], 'mouth.x': [-1, 1], 'mouth.y': [-1, 1],
};

function clampActionValue(action, v) {
  const [lo, hi] = ACTION_RANGE[action] || [-1, 1];
  return Math.min(hi, Math.max(lo, v));
}

// base 动作 → 角色实际绑定的并发动作（base 自身，或其 .left/.right 变体）。
function concreteActions(base, boundActions) {
  if (boundActions.has(base)) return [base];
  return [`${base}.left`, `${base}.right`].filter((a) => boundActions.has(a));
}

/**
 * 为「缺真实情绪表情」的 param 驱动角色（如 rattan/shuangsheng）按标准 FACS 映射
 * 生成 8 种情绪的语义表情单元。只驱动角色已绑定的标准面部动作，绝不碰头部/身体位置。
 * @param {Set<string>} boundActions 角色 semanticBindings 覆盖的 SemanticAction 集
 * @returns {Array} SemanticExpressionUnit[]
 */
export function canonicalEmotionUnits(boundActions) {
  const units = [];
  for (const [emotion, spec] of Object.entries(EMOTION_AU)) {
    const targets = [];
    for (const [base, value] of Object.entries(spec)) {
      for (const action of concreteActions(base, boundActions)) {
        const v = clampActionValue(action, value);
        targets.push({
          action,
          min: clampActionValue(action, v - 0.08),
          max: clampActionValue(action, v + 0.08),
        });
      }
    }
    if (targets.length === 0) continue; // 该情绪所需动作角色一个都没绑 → 跳过
    units.push({ type: 'semantic', id: `sem:emotion:${emotion}`, targets, emotions: { [emotion]: 0.9 } });
  }
  return units;
}
