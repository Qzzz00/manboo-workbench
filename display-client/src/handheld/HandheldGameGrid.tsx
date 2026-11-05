// 掌机桌面的游戏格：列出 ROM 本体（不是模拟器），点一款直接用对应模拟器开。
//
// 「模拟器默认打开方式 = 桌面选游戏」是 Ben 定的形态：选游戏这件事应该发生在桌面上，
// 而不是先开模拟器再进它自己的文件浏览器翻。
//
// 排版（2026-07-31 Ben 拍板）：顶部平台 tab + 3 列封面网格。
// 旧版是不分平台的 2 列大格子，480px 宽的屏上每格 222px 却只画一个 54px 的方块，
// 空得离谱且找游戏要一路滚。
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import Handheld from '../lib/handheldPlugin.ts';
import { launchHandheldRom } from './handheldGameLaunch.ts';
import RadioLauncher from '../lib/radioLauncherPlugin.ts';
import { AppDrawerBody, type AppEntry } from '../radio/AppDrawerSheet.tsx';
import { sortGamesFirst } from './handheldGames.ts';
import { ROM_SOURCES, romDisplayName, sortRoms } from './handheldRoms.ts';
import {
  coverCandidates,
  groupByPlatform,
  loadSelectedPlatform,
  saveSelectedPlatform,
  type PlatformGroup,
  type RomItem,
} from './handheldCovers.ts';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; groups: PlatformGroup[] }
  | { kind: 'no-native' };

/**
 * 一个游戏格的封面。
 * ★不预先扫封面目录：路径直接算出来交给 <img>，png 加载失败换 jpg、再失败才回落色块。
 * 这样零原生改动、也不多一次 IO——Ben 往 covers/ 丢一张图，重进这页就亮了。
 */
function RomCover({ rom }: { rom: RomItem }) {
  const candidates = coverCandidates(rom);
  // rom.path 作 key 的重挂载语义：换游戏就重试封面，不留上一张的失败状态。
  const [attempt, setAttempt] = useState(0);
  const src = candidates[attempt];

  if (src === undefined) {
    // 没配封面：平台色块 + 游戏名首字。比原来那个统一的紫方块至少能认出是哪一款。
    return (
      <span className="hh-rom-cart" aria-hidden="true">
        {romDisplayName(rom).slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      className="hh-rom-cover"
      src={Capacitor.convertFileSrc(src)}
      alt=""
      loading="lazy"
      onError={() => setAttempt((n) => n + 1)}
    />
  );
}

export function HandheldGameGrid({
  avatarId,
  view,
  onBack,
  onOpenApps,
  onCloseApps,
}: {
  avatarId: string;
  view: 'games' | 'apps';
  onBack: () => void;
  onOpenApps: () => void;
  onCloseApps: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [platform, setPlatform] = useState<string | null>(null);
  const [apps, setApps] = useState<AppEntry[] | null>(null);

  useEffect(() => {
    // 逐个目录扫，任一目录读不到只是它没贡献游戏，不该让整页变空态
    // （比如只放了 GBA 没建 PS1 目录，那是常态不是错误）。
    Promise.all(
      ROM_SOURCES.map((src) =>
        Handheld.listRoms({ dir: src.dir, extensions: src.extensions, maxDepth: 2 })
          // 平台标签与根目录在这里打上：原生只认「一个目录里有哪些文件」，
          // 「这些文件属于哪个平台」是前端的清单知识（ROM_SOURCES）。
          .then((r): RomItem[] =>
            r.roms.map((rom) => ({ ...rom, platform: src.dir, rootDir: r.dir })),
          )
          .catch(() => null),
      ),
    )
      .then((results) => {
        // 全部失败 = 没有原生插件（网页环境）
        if (results.every((r) => r === null)) {
          setState({ kind: 'no-native' });
          return;
        }
        // ★先按 ROM_SOURCES 的顺序聚组（tab 位置才固定），再在组内排序。
        // 反过来先全局排序会让 tab 顺序变成「各平台首个游戏的字母序」=每次装新游戏都可能变。
        const groups = groupByPlatform(results.flatMap((r) => r ?? [])).map((g) => ({
          platform: g.platform,
          roms: sortRoms(g.roms),
        }));
        setState({ kind: 'ok', groups });
        setPlatform(loadSelectedPlatform(groups.map((g) => g.platform)) ?? ROM_SOURCES[0]?.dir ?? null);
      })
      .catch(() => setState({ kind: 'no-native' }));
  }, []);

  useEffect(() => {
    if (view !== 'apps' || apps !== null) return;
    RadioLauncher.listApps()
      .then((r) => setApps(sortGamesFirst(r.apps as AppEntry[])))
      .catch(() => setApps([]));
  }, [view, apps]);

  function selectPlatform(next: string) {
    setPlatform(next);
    saveSelectedPlatform(next);
  }

  function launch(rom: RomItem) {
    launchHandheldRom(avatarId, rom);
  }

  if (view === 'apps') {
    return (
      <div className="hh-games">
        <button className="hh-games-back" onClick={onCloseApps} aria-label="返回游戏列表">
          <img src="./handheld/figma/games-back.svg" alt="" />
        </button>
        <AppDrawerBody
          apps={apps}
          onLaunch={(pkg) => void RadioLauncher.launchApp({ pkg }).catch(() => {})}
        />
      </div>
    );
  }

  const groups = state.kind === 'ok' ? state.groups : [];
  const current = groups.find((g) => g.platform === platform) ?? null;
  const groupByName = new Map(groups.map((g) => [g.platform, g]));

  return (
    <div className="hh-games">
      <div className="hh-games-top">
        <button className="hh-games-back" onClick={onBack} aria-label="返回首页">
          <img src="./handheld/figma/games-back.svg" alt="" />
        </button>
        <button className="hh-apps-toggle" onClick={onOpenApps}>
          <img src="./handheld/figma/games-apps.svg" alt="" />
          <span>应用</span>
        </button>
      </div>

      <div className="hh-platforms">
        {ROM_SOURCES.map((src) => {
          const g = groupByName.get(src.dir);
          return (
            <button
              key={src.dir}
              className="hh-platform"
              data-platform={src.dir}
              aria-pressed={src.dir === platform}
              onClick={() => selectPlatform(src.dir)}
            >
              {src.dir}
              <span className="hh-platform-count">{g?.roms.length ?? 0}</span>
            </button>
          );
        })}
      </div>

      {state.kind === 'loading' ? <div className="hh-empty">加载中…</div> : null}
      {state.kind === 'no-native' ? <div className="hh-empty">网页环境，无法读取游戏</div> : null}
      {state.kind === 'ok' && groups.length === 0 ? (
        <div className="hh-empty">
          没有找到游戏
          <div className="hh-empty-sub">
            把 ROM 放进 {ROM_SOURCES.map((s2) => `/${s2.dir}`).join(' 或 ')}
          </div>
        </div>
      ) : null}

      {current ? (
        <div className="hh-romgrid">
          {current.roms.map((rom) => (
            <button
              key={rom.path}
              className="hh-rom"
              data-platform={rom.platform}
              onClick={() => launch(rom)}
              aria-label={romDisplayName(rom)}
            >
              <RomCover key={rom.path} rom={rom} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
