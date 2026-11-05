'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/ttsSynthesizer.cjs
const volcengine = require('./volcengine.cjs');
const minimax = require('./minimax.cjs');

// encoding(2026-09-17 通道层):只有火山那条路认;minimax 的容器由它自己的 config 定,
// 传过去会被忽略——所以这里干脆不传给它,免得看起来像「传了但没生效」。
// 缺省 undefined 时也不往下传,由 volcengine.synthesize 用它自己的默认(mp3);
// /api/tts 那条路由会自己补 'mp3',所以老调用方拿到的东西一个字节都没变。
// `tone`(2026-10-02,卡「声音与形象跟着话走」):ttsTone.cjs 翻好的那三样
// ({emotion?, emotionScale?, contextText?})。**只有火山认它**;别家原样忽略,
// 不在这儿编一个等效参数(minimax 连 encoding 都不认,见文件头)。
async function synthesize({ provider, text, voice, emotion, speed, encoding, tone }) {
  if (!provider || !provider.provider_type) throw new Error('ttsSynthesizer: provider required');
  const provider_type = provider.provider_type;
  const config = provider.config;

  if (provider_type === 'volcengine') {
    return volcengine.synthesize({ config, text, voice, emotion, speed, ...(tone ? { tone } : {}), ...(encoding ? { encoding } : {}) });
  } else if (provider_type === 'minimax') {
    return minimax.synthesize({ config, text, voice, emotion, speed });
  } else {
    throw new Error(`ttsSynthesizer: unsupported provider_type ${provider_type}`);
  }
}

module.exports = { synthesize };
