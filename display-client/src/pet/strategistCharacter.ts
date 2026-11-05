// 底条那只角色的人设 → 一句能塞进军师 prompt 的话。
//
// ★为什么在客户端拼、随请求发给服务端：`avatarData.ts` 是人设的**唯一真相源**
// （同一份数据还喂着 TTS 音色和 Live2D 表情）。服务端再存一份，改角色时两边必漂。
//
// ★为什么值得做：军师原来只知道自己叫「军师」——那是个职务不是角色。prompt 里
// 一句人设都没有，于是她用着这只角色的声音、驱动着她的表情，唯独说出口的话
// 跟她没关系。Ben 原话「好无聊好官方」。

import { getAvatarById } from '../features/live2d/avatarData.ts';

/** 太长会把防幻觉规则挤到后面去——人格只值这么多字。 */
const MAX_CHARS = 120;

/**
 * 拼出「你说话的口吻按这个角色来：…」后面那一段。
 * 拿不到角色或它没写人设就返回空串 → 服务端退回没有人格的老样子。
 */
export function characterPrompt(avatarId: string | undefined): string {
  const p = avatarId ? getAvatarById(avatarId)?.persona : undefined;
  if (!p) return '';
  // ★只取 tone + traits，**不带 styleRules**。第一版取了 styleRules 前两条，
  // 结果恰好是最没用的两条：双生的第一条讲**音色**（「柔美悠扬的声音」——那归 TTS，
  // 不归文字），第二条是「温暖的毯子、星空下的窗户、牛奶和蜂蜜的气息」——
  // 往道馆攻略里塞这种意象是负分。真正解「官方腔」的是第五条「像困倦亲昵的伙伴
  // 深夜闲聊」，但按序号取命中不了它，按关键词挑又太脆。
  // 所以分工：**角色只提供「什么味道」**，「怎么写」由服务端一条固定的写法规则给
  // （见 chat/prompt.py）——那条是这块小屏幕 + 要念出来的**介质**约束，
  // 本来就不该由角色数据来决定。
  const bits = [p.tone, p.traits?.length ? p.traits.join('、') : ''].filter(Boolean);
  return bits.join('；').slice(0, MAX_CHARS);
}
