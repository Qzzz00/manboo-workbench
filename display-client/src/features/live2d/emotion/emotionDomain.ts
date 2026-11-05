// SoulLink 情绪层允许写入的 Cubism 参数域白名单。
// 明确排除：口型开合(ParamMouthOpenY/ParamMouthOpen，TTS 驱动) 与 换装参数(Param67 等，costume 驱动)。
// 嘴角形状 ParamMouthForm 属于表情(微笑/撇嘴)而非口型开合，纳入情绪域。
//
// 白名单需覆盖 shuangsheng.profile.json 的 parameterMap 里 EVERY target/targets[]（权威来源，
// 见 src/features/live2d/emotion/profiles/shuangsheng.profile.test.ts 的反向校验）。
export const EMOTION_DOMAIN_PATTERNS: RegExp[] = [
  /^ParamAngle[XYZ]$/i,          // 头部角度
  /^ParamBodyAngle[XYZ]$/i,      // 上身角度
  /^ParamBrow(L|R)?(X|Y|Angle|Form)$/i, // 眉：位置(X/Y)/角度/形状(挑眉/皱眉)
  /^ParamEye(L|R)Open$/i,        // 眼开合
  /^ParamEye(L|R)Smile$/i,       // 笑眼(眯眼弧度)
  /^ParamEyeBall[XY]$/i,         // 眼球朝向
  /^ParamEyeForm$/i,             // 眼形(其他模型可能用这个命名笑眼)
  /^ParamMouthForm$/i,           // 嘴角形状(非开合)
  /^ParamCheek$/i,               // 脸颊(害羞/鼓腮)
  /^ParamBreath$/i,              // 呼吸
];

// shuangsheng 模型的数字命名私有情绪参数(腮红/眼泪)。这些 id 在该模型里语义固定，
// 但换装参数 Param67 也是纯数字命名——绝不能用 /^Param\d+$/ 这种宽正则，否则会把
// Param67 一并放行进情绪域。这里用精确白名单逐一列出，P2 泛化到其他模型时在此追加/替换。
const SHUANGSHENG_NUMBERED_EMOTION_PARAM_IDS = new Set<string>([
  'Param52', // 眼泪
  'Param54', // 腮红
  'Param55', // 腮红
  'Param88', // 眼泪
]);

const MOUTH_OPEN_PATTERN = /^ParamMouthOpen/i; // 口型开合，永不进情绪域

export function isEmotionDomainParam(id: string): boolean {
  if (MOUTH_OPEN_PATTERN.test(id)) return false;
  if (SHUANGSHENG_NUMBERED_EMOTION_PARAM_IDS.has(id)) return true;
  return EMOTION_DOMAIN_PATTERNS.some((re) => re.test(id));
}

export function filterEmotionParams(
  params: Record<string, number>,
  reserved: { costumeIds: Iterable<string>; mouthIds: Iterable<string> },
): { kept: Map<string, number>; conflicts: string[] } {
  const reservedSet = new Set<string>([...reserved.costumeIds, ...reserved.mouthIds]);
  const kept = new Map<string, number>();
  const conflicts: string[] = [];
  for (const [id, value] of Object.entries(params)) {
    if (!isEmotionDomainParam(id)) continue;
    if (reservedSet.has(id)) {
      conflicts.push(id);
      continue;
    }
    kept.set(id, value);
  }
  return { kept, conflicts };
}
