/**
 * 电子吧唧模拟客户端：不依赖硬件验收 /ws/badge 全流程（badge-voice-plan.md §4.3）。
 *
 * 用法：
 *   node scripts/badge-client-sim.cjs --token <jwt> --character <avatarId> --audio <16k-mono.pcm> \
 *     [--url ws://localhost:3456/ws/badge] [--out /tmp/badge-reply.pcm] [--fast]
 *
 * 测试音频制作（macOS）：
 *   say -v Tingting -o /tmp/badge-test.aiff "今天天气怎么样呀"
 *   ffmpeg -y -i /tmp/badge-test.aiff -f s16le -ar 16000 -ac 1 /tmp/badge-test.pcm
 *
 * 验收回放：
 *   ffplay -f s16le -ar 16000 -ch_layout mono /tmp/badge-reply.pcm
 */
'use strict';

const fs = require('fs');
const WebSocket = require('ws');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const URL_ = arg('url', 'ws://localhost:3456/ws/badge');
const TOKEN = arg('token', process.env.BADGE_TOKEN);
const CHARACTER = arg('character', 'yumi');
const AUDIO = arg('audio');
const OUT = arg('out', '/tmp/badge-reply.pcm');
const FAST = has('fast');

if (!TOKEN || !AUDIO) {
  console.error('usage: node scripts/badge-client-sim.cjs --token <jwt> --character <id> --audio <pcm>');
  process.exit(1);
}

let pcm = fs.readFileSync(AUDIO);
if (pcm.subarray(0, 4).toString() === 'RIFF') {
  const idx = pcm.indexOf(Buffer.from('data'));
  pcm = pcm.subarray(idx + 8); // 容忍 WAV：跳过 data 段头
  console.log(`[sim] WAV detected, stripped header, pcm=${pcm.length} bytes`);
}

const CHUNK = 3200; // 100ms @16k/16bit/mono，对齐固件上行节奏
const t = { start: Date.now() };
const ms = () => Date.now() - t.start;
const replyChunks = [];

const ws = new WebSocket(URL_);
ws.on('error', (e) => { console.error('[sim] ws error:', e.message); process.exit(1); });

ws.on('open', () => {
  console.log(`[sim] connected ${URL_} (+${ms()}ms)`);
  ws.send(JSON.stringify({ type: 'hello', device_id: 'sim-001', token: TOKEN, character_id: CHARACTER }));
});

ws.on('message', async (data, isBinary) => {
  if (isBinary) {
    if (replyChunks.length === 0) console.log(`[sim] ★ first audio chunk (+${ms() - t.speechEnd}ms after speech_end)`);
    replyChunks.push(data);
    return;
  }
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case 'hello_ack': {
      console.log(`[sim] hello_ack session=${msg.session_id} (+${ms()}ms)`);
      ws.send(JSON.stringify({ type: 'speech_start' }));
      const interval = FAST ? 0 : 100;
      for (let off = 0; off < pcm.length; off += CHUNK) {
        ws.send(pcm.subarray(off, off + CHUNK));
        if (interval) await new Promise((r) => setTimeout(r, interval));
      }
      ws.send(JSON.stringify({ type: 'speech_end' }));
      t.speechEnd = ms();
      console.log(`[sim] speech_end sent, audio=${(pcm.length / 32000).toFixed(1)}s (+${t.speechEnd}ms)`);
      break;
    }
    case 'asr_text':
      console.log(`[sim] ASR: "${msg.text}" (+${ms() - t.speechEnd}ms after speech_end)`);
      break;
    case 'state':
      console.log(`[sim] state=${msg.value} (+${ms() - t.speechEnd}ms after speech_end)`);
      break;
    case 'reply_text':
      console.log(`[sim] REPLY: "${msg.text}" (+${ms() - t.speechEnd}ms after speech_end)`);
      break;
    case 'tts_end': {
      const total = Buffer.concat(replyChunks);
      fs.writeFileSync(OUT, total);
      console.log(`[sim] tts_end: ${total.length} bytes (${(total.length / 32000).toFixed(1)}s audio) → ${OUT}`);
      console.log(`[sim] 验收: ffplay -f s16le -ar 16000 -ch_layout mono ${OUT}`);
      ws.close();
      process.exit(0);
      break;
    }
    case 'error':
      console.error(`[sim] SERVER ERROR: ${msg.message}`);
      break;
    default:
      console.log('[sim] <-', msg);
  }
});

setTimeout(() => { console.error('[sim] timeout (60s)'); process.exit(1); }, 60000);
