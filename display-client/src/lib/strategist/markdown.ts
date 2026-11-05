// 把模型漏出来的 markdown 记号剥掉。
//
// ★为什么需要（2026-08-02 Ben）：「TTS 总会把**读成星星」。底条面板渲染的是
// 纯文本（不是 markdown），语音是逐句念——加粗星号在两条通道上都是噪音。
// 服务端 prompt 已经禁了 markdown，这里是皮带之外的吊裤带：模型偶尔还是会漏。
//
// ★只删记号不动内容；流式切片可能把 `**` 劈成两半，所以调用方要在**攒完整句**
// 之后再调（strategistSpeech 的缓冲天然满足；面板每次拿到的是全量文本）。
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // **加粗** / *斜体* 成对的
    .replace(/\*+/g, '') // 残留的孤星（流式边界劈开的那种）
    .replace(/`+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^[ \t]*[-•]\s+/gm, ''); // 列表横线（TTS 会念成「杠」）
}
