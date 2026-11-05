'use strict';

// 流式回包里把 usage 挑出来。**只看,不改**——转出去的字节与上游回来的一模一样。
//
// ## 为什么非要挑出来
//
// 计量。非流式的回包里有 `usage`,流式默认**没有**;OpenAI 兼容的做法是请求里加
// `stream_options: { include_usage: true }`,上游就会在最后多发一个
// `choices: []` 且带 `usage` 的块。所以中转会**强制**把这个开关打开
// (见 upstream.cjs 的 `withUsageOptions`):不打开就等于「流式请求不计量」,
// 那么只要客户端一律用流式,额度就是形同虚设。
//
// 代价:客户端即使显式写了 `include_usage: false` 也会收到那一个块。
// 主流 OpenAI 客户端(含 @livekit/agents-plugin-openai)都认得它,
// 这条写在交接文档的「限制」一节里。
//
// ## 为什么要自己缓行
//
// 上游的 chunk 边界跟 SSE 的行边界没有关系,一个 `data: {...}` 可能被切成两半。
// 所以这里留一个 `buffer`,只处理完整的行,剩的半行等下一块。

/**
 * 造一个嗅探器。`push(text)` 喂解码后的文本,`usage()` 回最后一次看到的 usage。
 * 解析不出来、没有 usage、JSON 坏了,一律当作「没看到」——**绝不抛**:
 * 一个计量用的旁路解析器把用户的回答打断,是最不划算的失败。
 */
function createUsageSniffer() {
  let buffer = '';
  let seen;

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(payload); }
    catch { return; }
    const usage = parsed?.usage;
    if (usage !== null && typeof usage === 'object') seen = usage;
  }

  return {
    push(text) {
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      // 缓冲不设上限会被一条超长的畸形行撑爆内存;正常的 SSE 行远小于 1MB。
      if (buffer.length > 1_000_000) buffer = '';
    },
    /** 流结束时叫一次:最后一行可能没有换行符收尾。 */
    end() {
      if (buffer !== '') { handleLine(buffer); buffer = ''; }
    },
    usage() { return seen; },
  };
}

module.exports = { createUsageSniffer };
