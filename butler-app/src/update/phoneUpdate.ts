/**
 * 手机包:带版本号,在 App 里直接更新(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 维护者原话(装了 0.4.90 手机包之后):
 * 「手机端现在每次更新我都得跳转官网去下载,而且包也没有版本号……」
 *
 * 09-28 卡 UP 把这一节改成「一节、一个动作、包指官网」—— 那一版治的是
 * 「两条会过期的 apk 直链 + 两个按钮谁也看不懂」。可代价是**她每次更新都要跳一趟浏览器**,
 * 而且那边下回来的包界面上压根不知道是哪一版(`versionName` 一直写死 1.0)。
 * 这一版两件一起补上:
 *   1. 包自己带版本号(构建时从 workbench-plugin/package.json 写进 versionName 与 build.json);
 *   2. 下载与安装在 App 里做完(原生 ApkUpdatePlugin:流式下载 + sha256 核对 + 调起系统安装器)。
 * 官网那条路**留着但降成小字**:下不动时她还有一条退路,但不再是唯一的路。
 *
 * ## 这一份里只有纯的
 *
 * 版本比较、拿清单里哪一格、校验码核对、进度与失败文案、「已更新到」那一句 ——
 * 全是数出来的,**没有一句是编的**:本机版本号认不出就说认不出,电脑没查过清单就整节不出现,
 * 清单那份没给校验码就不装并说明为什么。真下载与真安装在
 * `android/app/src/main/java/ai/ben/butler/ApkUpdatePlugin.java`,外壳在 `apkUpdater.ts`。
 *
 * ## 版本号从哪儿来
 *
 * 手机包**没有自己的版本号**,它跟着工作台一起发(清单里 `assets.apk` 那一格的版本
 * 就是清单的版本,这一版没重打就带 `from_version`,见 deploy/publish-update.sh 卡 U8)。
 * 所以本机那一边也得是同一个号:构建时从 `workbench-plugin/package.json` 取,
 * 写进 `versionName` 与 `public/build.json` 的 `version`(scripts/write-build-stamp.mjs)。
 */
import type { PhoneCellView } from '../api/protocol';

/**
 * 安装包也能从官网拿(2026-09-28 卡 UP 起这里只有官网;2026-10-03 起**降成小字退路**)。
 * 界面上不出现 apk 直链 —— 直链会过期,官网上那份永远是最新的。
 */
export const OFFICIAL_SITE = 'www.aibooo.cn';

/** 「32 MB」这种。跟 Mac 那边同一个写法(workbench-plugin/src/server/update/types.ts)。 */
export function apkSizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 清单里那一份手机包。`sha256` 可缺(老工作台的 `update_available_apk` 那一格没有)。 */
export interface PhoneApkOffer {
  version: string;
  url: string;
  size: number;
  sha256?: string;
}

/** `/state` 里与手机包有关的那几格(protocol.ts 的 StateView)。 */
export interface PhoneApkState {
  phone_apk?: { version: string; url: string; size: number; sha256?: string };
  update_available_apk?: { version: string; url: string; size: number };
  phone_cells?: readonly PhoneCellView[];
}

/** 首页那一句(2026-10-09):手机包落后于电脑上记的某一格时说。 */
export const PHONE_BEHIND_TEXT = '电脑上的事务官更新了,手机端也更新一下';

/**
 * 这台手机是不是落在了电脑后面(2026-10-09,卡「四件小事」第 1 件)。
 *
 * 判据只用数得出来的:自己装的版本 `mine` 与电脑记的「哪一版起手机才有这一格」(`/state.phone_cells`)比。
 * 只在**真能一键装上**时说:电脑那份包比 `mine` 新、带校验码(同设置里那颗键的门槛)。
 * 版本认不出 / 老工作台没这张表 / 没有更新的包 → undefined,不说(不猜)。
 * 表里认不出版本号的那一行跳过,不当成缺。
 */
export function phoneBehind(args: { cells?: readonly PhoneCellView[]; mine?: string; offer?: PhoneApkOffer }): { missing: string[]; offer: PhoneApkOffer } | undefined {
  const { cells, mine, offer } = args;
  if (cells === undefined || cells.length === 0 || offer === undefined || mine === undefined) return undefined;
  if (phoneUpdateVerdict({ offer, mine }).kind !== 'newer') return undefined;
  const missing = cells.filter((one) => (comparePhoneVersions(one.since, mine) ?? 0) > 0).map((one) => one.title);
  return missing.length === 0 ? undefined : { missing, offer };
}

/**
 * 拿清单里哪一格。**优先 `phone_apk`**:
 *   · 它带 `sha256` —— 没有校验码就核不了,核不了这张卡就不装;
 *   · 它答的是「那个包**在哪**」,查过一次清单就一直在(`update_available_apk` 只在
 *     插件真有新版、而且这一版真重打了手机包时才给 —— 手机自己落后几版时它压根不出现)。
 *   · 它的 `version` 说的是那份包**真出自哪一版**(清单里 `from_version` 带了就照它),
 *     正好能跟手机上装着的那个 `versionName` 直接比。
 */
export function pickPhoneApk(state: PhoneApkState): PhoneApkOffer | undefined {
  const cloud = state.phone_apk;
  if (cloud !== undefined) {
    return { version: cloud.version, url: cloud.url, size: cloud.size, ...(cloud.sha256 === undefined ? {} : { sha256: cloud.sha256 }) };
  }
  const newer = state.update_available_apk;
  if (newer !== undefined) return { version: newer.version, url: newer.url, size: newer.size };
  return undefined;
}

/** 三段数字才认。认不出一律 undefined —— **不编一个** 0.0.0 出来。 */
export function parsePhoneVersion(raw: string | undefined): readonly [number, number, number] | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 逐段按**数字**比。任一边认不出就 undefined ——
 * 退化成「一样」会让一个认不出版本号的包永远不提示更新。
 */
export function comparePhoneVersions(a: string, b: string): number | undefined {
  const left = parsePhoneVersion(a);
  const right = parsePhoneVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 这台手机上装的是哪一版。**原生报的(真 APK 的 `versionName`)优先** ——
 * 它是系统从包里读出来的,比网页侧那份 `build.json` 更贴近"真装着的是什么"。
 * 原生报了个认不出的(没经 pnpm build 打出来的包,`versionName` 还是占位值)就退到 build.json;
 * 两边都认不出就 undefined,界面上如实说认不出。
 */
export function localPhoneVersion(args: { native?: string; stamp?: string }): string | undefined {
  if (parsePhoneVersion(args.native) !== undefined) return args.native;
  if (parsePhoneVersion(args.stamp) !== undefined) return args.stamp;
  return undefined;
}

export type PhoneUpdateVerdict =
  /** 电脑没查过清单(或者这一版压根没带手机包):整节不出现。 */
  | { kind: 'none' }
  /** 清单里那份比手机上这份新:给一个动作。 */
  | { kind: 'newer'; offer: PhoneApkOffer; title: string; detail: string; action: string }
  /** 手机上装的就是清单里那一份。 */
  | { kind: 'same'; offer: PhoneApkOffer; title: string; detail: string }
  /** 手机上这份比清单里那份新(维护者自己打的包):什么都不劝。 */
  | { kind: 'older'; offer: PhoneApkOffer; title: string; detail: string }
  /** 手机上这份认不出版本号:照样给动作,但话说清楚。 */
  | { kind: 'unknown-local'; offer: PhoneApkOffer; title: string; detail: string; action: string }
  /** 该下了,可清单那份没给校验码:**不装**,说明为什么。 */
  | { kind: 'no-sha'; offer: PhoneApkOffer; title: string; detail: string };

/** 「手机包」那一节的标题:只有真有新版时才换成「手机端有新版」。 */
const TITLE_PLAIN = '手机包';
const TITLE_NEWER = '手机端有新版';

/** 64 位十六进制才算一个校验码。 */
function looksLikeSha(value: string | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * 该不该更新,以及屏上说什么。**两个版本号都写在话里** ——
 * 09-28 那一版只说"有新版 0.4.22",她看不出自己手上是哪一版。
 */
export function phoneUpdateVerdict(args: { offer?: PhoneApkOffer; mine?: string }): PhoneUpdateVerdict {
  const { offer } = args;
  if (offer === undefined) return { kind: 'none' };
  const size = apkSizeText(offer.size);
  const mine = parsePhoneVersion(args.mine) === undefined ? undefined : args.mine;
  const relation = mine === undefined ? undefined : comparePhoneVersions(offer.version, mine);

  // 本机版本号认不出。多半就是该换掉的那种包(没经 pnpm build 打出来的),所以照样给动作。
  if (mine === undefined) {
    if (!looksLikeSha(offer.sha256)) return noSha(offer, size);
    return {
      kind: 'unknown-local',
      offer,
      title: TITLE_PLAIN,
      detail: `认不出你这台手机上装的是哪一版(这个包多半不是正式构建出来的)。电脑上那一份是 ${offer.version}(${size})。`,
      action: `下载并安装 ${offer.version}`,
    };
  }
  if (relation === 0) {
    return { kind: 'same', offer, title: TITLE_PLAIN, detail: `你这台手机上装的就是电脑上那一份:${offer.version}(${size})。` };
  }
  if (relation !== undefined && relation < 0) {
    return { kind: 'older', offer, title: TITLE_PLAIN, detail: `你这台手机上装的是 ${mine},比电脑上那一份(${offer.version})还新 —— 不用更新。` };
  }
  // 要下了。没校验码就不下 —— 核不了不等于核过了。
  if (!looksLikeSha(offer.sha256)) return noSha(offer, size);
  return {
    kind: 'newer',
    offer,
    title: TITLE_NEWER,
    detail: `你这台手机上装的是 ${mine},电脑上那一份是 ${offer.version}(${size})。`,
    action: `有新版 ${offer.version},下载并安装`,
  };
}

function noSha(offer: PhoneApkOffer, size: string): PhoneUpdateVerdict {
  return {
    kind: 'no-sha',
    offer,
    title: TITLE_PLAIN,
    detail: `电脑上那份清单没给这个包的校验码(电脑上的工作台是旧版),核不了就不装 ${offer.version}(${size})。先在电脑上更新一次工作台。`,
  };
}

/** 下下来那份与电脑上记的对不上时那一句(同 fileSink.ts 的口径:对不上就不存)。 */
export const PHONE_UPDATE_SHA_MISMATCH_TEXT = '下下来这一份和电脑上记的校验码对不上(路上传坏了),没装;再按一次';

/** 第一次装的时候系统会问的那一句,照实先说出来。 */
export const PHONE_UPDATE_PERMISSION_TEXT = '第一次装的时候,系统会问你允不允许这个 App「安装未知应用」—— 允许一次就行,以后不再问。';

/** 系统那一项没允许时那一句(原生 `install` 回的也是它)。 */
export const PHONE_UPDATE_NEED_PERMISSION_TEXT = '系统还不允许这个 App「安装未知应用」。点下面那颗键去系统设置里打开它,回来再按一次。';

/**
 * 没装上时屏上那一句。**原因原样带出来,一个字不改,也不劝她去官网** ——
 * 她要照着这句话知道是没网、是服务器 404、还是校验对不上。
 */
export function phoneUpdateFailText(reason: string): string {
  const said = reason.trim();
  return `没装上:${said === '' ? '原生那边没说为什么(这是 bug,记一条)' : said}`;
}

/** 下下来那份的校验码对不对。任一边缺、位数不对一律不算对。 */
export function shaOk(expected: string | undefined, got: string | undefined): boolean {
  if (!looksLikeSha(expected) || !looksLikeSha(got)) return false;
  return (expected as string).toLowerCase() === (got as string).toLowerCase();
}

/** 「已下 12.0 MB / 32.0 MB(37%)」。总共多大不知道(服务器没报)就只说下了多少。 */
export function phoneDownloadProgressText(received: number, total: number): string {
  const got = apkSizeText(Math.max(0, received));
  if (!Number.isFinite(total) || total <= 0) return `已下 ${got}`;
  const percent = Math.min(100, Math.floor((Math.max(0, received) / total) * 100));
  return `已下 ${got} / ${apkSizeText(total)}(${percent}%)`;
}

/**
 * 更新完打开 App 那一句。**拿 build.json 里那一格与上次记下的比**,
 * 一样、或者从没记过就一个字不说(头一回装上这个功能的那台手机不该被恭喜一次)。
 */
export function justUpdatedText(args: { last?: string; now?: string }): string | undefined {
  const { last, now } = args;
  if (last === undefined || last === '' || now === undefined || now === '') return undefined;
  if (last === now) return undefined;
  const relation = comparePhoneVersions(now, last);
  if (relation === undefined) return `已换成 ${now}`;
  return relation > 0 ? `已更新到 ${now}` : `装的变成了 ${now}(比上次那一份旧)`;
}
