// 来源:Aiboo origin/main 7c55ce12 server/services/ttsChunker.cjs(原样;只给 DashScope 类型的 TTS 供应商用)
/**
 * Shared TTS chunking + DashScope synthesis helpers.
 *
 * Previously duplicated verbatim in server.cjs (/ai/tts) and routes/messages.cjs
 * (regenerate-media). `splitTextForTts` was identical in both; `generateTtsChunk`
 * here uses the more general signature (explicit endpoint + optional instructions)
 * so both call sites can share it without behavior change — messages.cjs passes
 * the hard-coded endpoint and omits instructions, exactly as before.
 */

const MAX_TTS_CHARS_PER_CHUNK = 80; // ~4 Chinese chars/sec * 20 sec

const DASHSCOPE_TTS_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

function splitTextForTts(text, maxChars = MAX_TTS_CHARS_PER_CHUNK) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const sentenceEnd = Math.max(
        text.lastIndexOf('。', end),
        text.lastIndexOf('！', end),
        text.lastIndexOf('？', end),
        text.lastIndexOf('.', end),
        text.lastIndexOf('!', end),
        text.lastIndexOf('?', end),
      );
      const phraseEnd = Math.max(
        text.lastIndexOf('，', end),
        text.lastIndexOf(',', end),
        text.lastIndexOf('、', end),
      );
      const best = sentenceEnd > start ? sentenceEnd + 1 : (phraseEnd > start ? phraseEnd + 1 : end);
      if (best > start) end = best;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

async function generateTtsChunk(text, model, voice, language_type, instructions, apiKey, endpoint = DASHSCOPE_TTS_ENDPOINT) {
  const ttsResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: {
        text,
        voice,
        language_type,
        ...(instructions ? { instructions, optimize_instructions: true } : {}),
      },
    }),
  });

  const ttsData = await ttsResponse.json();
  if (!ttsResponse.ok) {
    throw new Error(ttsData.message || 'TTS generation failed');
  }

  const audioUrl = ttsData.output?.audio?.url;
  if (!audioUrl) {
    throw new Error('No audio URL in TTS response');
  }

  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error('Failed to fetch audio from upstream');
  }

  return Buffer.from(await audioResponse.arrayBuffer());
}

module.exports = {
  MAX_TTS_CHARS_PER_CHUNK,
  DASHSCOPE_TTS_ENDPOINT,
  splitTextForTts,
  generateTtsChunk,
};
