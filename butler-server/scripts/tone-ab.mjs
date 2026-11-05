#!/usr/bin/env node
// 语气盲听:**同一段话,带语气与不带语气各合一次**(2026-10-02,卡「声音与形象跟着话走」第 6 件)。
//
// 为什么有这个脚本:语气这件事没法靠用例验收 —— 请求体里拼没拼上那三格,
// tests/tts-tone.test.mjs 已经钉死了;**好不好听只能听**。所以这里把同一段回话
// 合出几份音频摆在一个目录里,文件名只写编号与语气,维护者自己点开比。
//
// 跑:
//   node butler-server/scripts/tone-ab.mjs --out ~/Desktop/语气盲听
//
// 参数:
//   --url   8792 的地址(缺省 http://127.0.0.1:8792,也可用 BUTLER_URL)
//   --out   输出目录(缺省 ./tone-ab)
//   --text  要念的那一段(缺省下面那三句各来一遍)
//   --tones 只合这几个语气(逗号分隔;缺省 calm,care,happy,sorry,urgent,soft,ask)
//
// 三条纪律:
//   1. **串行**,句与句之间歇一下 —— 并发会撞火山的配额(09-20 那次 502 的真因);
//   2. **不出口凭据**:回环调 8792 压根不用令牌,也不读他的任何密钥文件;
//   3. 合不出来就**如实记一行**接着往下走 —— 这是一份听材料,少一份比整份没有好。
//
// ⚠️ 它向哪台 8792 要音频,就验的是哪台的代码。装着的那台(launchd 拉起的)是**发版过的那一份**:
//    在这张卡合并发版之前,它收不到 `tone` 这一格,所以同时也发一份等效的 `emotion`
//    (语气映射表里那个枚举)—— 于是这份材料在**新旧两台**上都听得出区别:
//      · 老 8792:`emotion` 生效(V1 那条路),`context_texts` 那半截听不到;
//      · 新 8792:`tone` 生效(两格都有),2.0 音色走 V3 时还多一句自然语言指令。
//    manifest.json 里如实记了每一份是带着哪几格发出去的。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ttsTone = require(resolve(here, '..', 'server', 'services', 'ttsTone.cjs'));

/** 一句和下一句之间歇多久(见纪律 1)。 */
const GAP_MS = 300;

/** 缺省那三段。挑的是真机里出现过、而且语气差别最该听出来的三句。 */
const DEFAULT_TEXTS = [
  { id: 's1', text: '好的,我这就去安排,办完打电话告诉你。' },
  { id: 's2', text: '那件事我没办成,卡在那家窗口没开,我再试一次。' },
  { id: 's3', text: '你今天听着有点累,要不要先把这件事放到明天?' },
];

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1] !== undefined && !process.argv[at + 1].startsWith('--')) return process.argv[at + 1];
  return fallback;
}

const url = arg('url', process.env.BUTLER_URL ?? 'http://127.0.0.1:8792').replace(/\/+$/, '');
const outDir = resolve(process.cwd(), arg('out', 'tone-ab'));
const only = (arg('tones', '') || '').split(',').map(one => one.trim()).filter(one => one !== '');
const tones = only.length > 0 ? only : ttsTone.knownTones();
const texts = (() => {
  const given = arg('text', undefined);
  return given === undefined ? DEFAULT_TEXTS : [{ id: 's1', text: given }];
})();

async function synth(body) {
  const res = await fetch(`${url}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene: 'chat', encoding: 'mp3', ...body }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const said = await res.json();
      detail = [said?.error, said?.detail].filter(one => typeof one === 'string' && one !== '').join(';');
    } catch { /* 读不懂就只报状态码,不编一个原因 */ }
    throw new Error(`8792 /api/tts 回了 ${res.status}${detail === '' ? '' : `:${detail}`}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error('8792 回了 200 但一个字节都没有');
  return buffer;
}

mkdirSync(outDir, { recursive: true });
console.log(`8792:${url}(回环,不带令牌)`);
console.log(`语气:不带 + ${tones.join(' / ')};段子 ${texts.length} 段 → ${outDir}`);

const entries = [];
let n = 0;
for (const one of texts) {
  // ① 不带语气那一份(对照组)。
  const plans = [{ tone: undefined, fields: {} }];
  for (const tone of tones) {
    const resolved = ttsTone.resolveTone(tone);
    plans.push({
      tone,
      resolved,
      // `tone` 给新 8792;`emotion` 给还没发版的那一台(见文件头那条 ⚠️)。
      fields: { tone, ...(resolved.emotion === undefined ? {} : { emotion: resolved.emotion }) },
    });
  }
  for (const plan of plans) {
    n += 1;
    if (n > 1) await new Promise(done => setTimeout(done, GAP_MS));
    const label = plan.tone === undefined ? '不带语气' : plan.tone;
    const file = `${one.id}-${String(n).padStart(2, '0')}-${label}.mp3`;
    try {
      const audio = await synth({ text: one.text, ...plan.fields });
      writeFileSync(join(outDir, file), audio);
      entries.push({
        file,
        text: one.text,
        tone: plan.tone ?? null,
        sent: Object.keys(plan.fields),
        resolved: plan.resolved ?? null,
        bytes: audio.length,
      });
      console.log(`  ✓ ${file.padEnd(34)} ${(audio.length / 1024).toFixed(1)} KB`);
    } catch (error) {
      // 纪律 3:如实记一行,接着往下走。
      entries.push({ file, text: one.text, tone: plan.tone ?? null, error: error.message });
      console.log(`  × ${file.padEnd(34)} ${error.message}`);
    }
  }
}

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({
  note: '由 butler-server/scripts/tone-ab.mjs 生成。每一份是带着哪几格发出去的、翻成了什么,都在这儿。',
  generated_at: new Date().toISOString(),
  url,
  files: entries,
}, null, 2)}\n`);
console.log(`\n共 ${entries.length} 份,清单在 ${join(outDir, 'manifest.json')}`);
