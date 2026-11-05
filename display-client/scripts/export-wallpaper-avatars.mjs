#!/usr/bin/env node
/**
 * 为 Live2D 动态壁纸烘「增强版 model3.json」。
 *
 * 为什么需要这一步：壁纸是纯原生（WallpaperService 只有 SurfaceHolder、没有 WebView），
 * 拿不到 avatarData.ts 的角色清单；而模型自带的 model3.json **不含任何 Motions 组与
 * Expressions**（ghostpuppy/tororo/hijiki 实测皆为空），动作全靠清单注入。所以必须在构建期
 * 把 createAugmentedSettings 的产物烘成文件，原生端直接读。
 *
 * 复用运行时同一份 createAugmentedSettings（modelSettings.ts），两端零漂移。
 * 纹理不做低端降档——构建期无从得知运行设备，保持原始路径。
 *
 * 产物（会被 vite build 拷进 dist、再由 cap sync 进 android assets）：
 *   public/live2D/_wallpaper/index.json          角色索引
 *   public/live2D/_wallpaper/<id>.settings.json  各角色增强后的 model3.json
 *
 * 用法：node scripts/export-wallpaper-avatars.mjs
 */
import { createServer } from 'vite';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'live2D/_wallpaper');
const OUT_REL = 'live2D/_wallpaper';

/** 与原生 AssetLoader 的约定一致（对齐 JS 侧 assetPathFromUrl）：assets 内一律 public/ 前缀。 */
function toAssetPath(url) {
  const clean = String(url).replace(/^\/+/, '');
  return clean.startsWith('assets/') ? clean.slice('assets/'.length) : `public/${clean}`;
}

/** 与 live2dEngine.findIdleMotionKey 同规则（那边带 PixiJS 依赖，构建期不能 import）。 */
function findIdleMotionKey(avatar) {
  if (!avatar.motions) return null;
  return Object.keys(avatar.motions).find((key) => /^idle/i.test(key)) ?? null;
}

async function main() {
  const server = await createServer({
    root: ROOT,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false },
  });

  let exported = 0;
  const skipped = [];
  try {
    const { avatars } = await server.ssrLoadModule('/src/features/live2d/avatarData.ts');
    const { createAugmentedSettings } = await server.ssrLoadModule(
      '/src/features/live2d/modelSettings.ts',
    );

    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });

    const index = {};
    for (const [id, avatar] of Object.entries(avatars)) {
      if (!avatar?.modelJson) {
        skipped.push(`${id}（无 modelJson）`);
        continue;
      }

      const modelRelative = decodeURI(String(avatar.modelJson)).replace(/^\/+/, '');
      const modelAbsolute = path.join(PUBLIC_DIR, modelRelative);

      let raw;
      try {
        raw = JSON.parse(await readFile(modelAbsolute, 'utf8'));
      } catch (err) {
        skipped.push(`${id}（model3.json 读不到: ${err.message}）`);
        continue;
      }

      const settings = createAugmentedSettings(raw, avatar);
      // 原生端不需要 url（且它是浏览器绝对路径，留着只会误导）——与 JS 侧 showModel 前的 delete 对齐
      delete settings.url;

      const idleGroup = findIdleMotionKey(avatar);
      if (!idleGroup) {
        console.warn(`  ⚠ ${id}: 没有匹配 /^idle/i 的动作组，壁纸上角色会静止不动`);
      }

      const settingsRel = `${OUT_REL}/${id}.settings.json`;
      await writeFile(
        path.join(PUBLIC_DIR, settingsRel),
        `${JSON.stringify(settings, null, 2)}\n`,
        'utf8',
      );

      const motionKeys = new Set(Object.keys(avatar.motions ?? {}));
      index[id] = {
        settingsFile: toAssetPath(settingsRel),
        modelDir: toAssetPath(modelRelative).replace(/[^/]+$/, ''),
        idleMotionGroup: idleGroup ?? '',
        idleBeatGroups: (avatar.idleBeats ?? []).filter((key) => motionKeys.has(key)),
        layout: { anchorXFrac: 0.5, bottomYFrac: 0.95, widthFrac: 0.9, heightFrac: 0.9 },
      };
      exported += 1;
    }

    if (exported === 0) {
      throw new Error('没有导出任何角色——壁纸一定黑屏，构建应当失败');
    }

    await writeFile(
      path.join(PUBLIC_DIR, `${OUT_REL}/index.json`),
      `${JSON.stringify(index, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await server.close();
  }

  console.log(`✅ 壁纸素材已烘好：${exported} 个角色 → public/${OUT_REL}/`);
  if (skipped.length > 0) {
    console.log(`   跳过 ${skipped.length} 个：${skipped.join('、')}`);
  }
}

main().catch((err) => {
  console.error('❌ 导出失败:', err);
  process.exit(1);
});
