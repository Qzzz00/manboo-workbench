// scripts/gen-soullink-profile.mjs
// 离线生成 shuangsheng DJ 模型的 SoulLink ModelProfile(启发式,不联网)。
// 用法: node scripts/gen-soullink-profile.mjs
import { Live2DProfileAutoGenerator } from '@soullink-emotion/profile-generator';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MODELS_ROOT = resolve(process.cwd(), 'public/live2D'); // 含各模型子目录的根
const MODEL_DIR = 'shuangsheng-dj';                          // shuangsheng DJ 完整模型子目录名

const generator = new Live2DProfileAutoGenerator({
  modelsRoot: MODELS_ROOT,
  modelsBaseUrl: '/live2D',
  useConfiguredOpenAI: false, // 启发式模式,零网络
});

const result = await generator.ensure({ modelDir: MODEL_DIR, displayName: 'Shuang Sheng', force: true });
console.log('provider:', result.provider, 'coverage:', JSON.stringify(result.coverage ?? {}));

// 把 ensure() 写到模型目录的 profile 复制到源码树入仓
const src = result.profileUrl.startsWith('/')
  ? resolve(process.cwd(), 'public' + result.profileUrl)
  : result.profileUrl;
const json = await readFile(src, 'utf8');
const dest = resolve(process.cwd(), 'src/features/live2d/emotion/profiles/shuangsheng.profile.json');
await writeFile(dest, json);
console.log('written ->', dest);
