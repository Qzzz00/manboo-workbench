/**
 * 手机导航:首页是唯一主页,别的页都是它的下一级(2026-09-24,卡 `fix/phone-nav-back`,维护者拍板)。
 *
 * 以前事项 / 资讯 / 设置是底部标签栏上的三格(09-17 舞台页那张卡:「事项 / 设置页留着标签栏好回来」),
 * 而首页上看不到那条栏、系统返回又不接 —— 进了设置只能点底部栏回来。现在:
 *   - 底部标签栏拿掉;
 *   - 事项、资讯、设置、对话记录、会议都是首页的下一级,左上角一个「‹」回首页;
 *   - 系统返回:下一级 → 回首页;首页 → 退到后台(不退出登录、不清状态);
 *   - 通话中 / 来电页 / 话筒那一通:返回**不挂断**(挂断只靠挂断键);
 *   - 引导打字页返回 → 回首页,进度保留,首页横幅接着聊。
 *
 * 这个文件只放**纯的**那一半:页名、壳那一层的返回怎么走。接线在 App.tsx 的 Shell。
 */

/** 壳里挂着的那几页。`stage` 是首页(舞台);另外的都是它的下一级。 */
export type Page = 'stage' | 'inbox' | 'news' | 'settings' | 'avatars' | 'reports' | 'history' | 'calls' | 'collab';

/**
 * 「各家最近的对话」那一页的名字(2026-10-03,卡「手机各家最近会话固定入口」)。
 * **首页那颗图标与这一页的返回头用同一个字符串** —— 读屏念的、长按飘出来的那几个字,和到了之后看到的那几个字必须一样
 * (2026-10-03 下午,卡「首页侧边小图标」:那条入口从主列里一行改成了球那一栏边上一颗小图标)。
 */
export const RECENT_SESSIONS_TITLE = '各家最近的对话';

/** 下一级页顶上那条返回头里的名字。 */
export const PAGE_TITLES: Record<Exclude<Page, 'stage'>, string> = {
  inbox: '事项',
  news: '资讯',
  settings: '设置',
  /** 形象陈列与下载(2026-10-01):首页形象区顶上那颗小方格、设置首屏「形象」一行都进这一页。 */
  avatars: '形象',
  /** 从事项页搬出来的三页(2026-10-01,docs/梳理-1001-手机事项页.md):入口在记录面板。 */
  reports: '汇报',
  history: RECENT_SESSIONS_TITLE,
  calls: '通话记录',
  /** 协作区(2026-10-24,卡「完整手机协作下级页」):目标/事项/频道的下级页,入口在事项页。 */
  collab: '协作区',
};

/** 另外两页的名字:对话记录长在舞台页上(StagePage 的 `log`),会议是整屏一页(MeetingPage)。 */
export const LOG_TITLE = '对话记录';
/** 2026-09-25(卡 J)起这一页先列「收到的文件」(点了能打开、能分享),下面才是传输记录。 */
export const TRANSFERS_TITLE = '收到的文件';
export const MEETING_TITLE = '会议';

/** 返回头左上角那颗「‹」的读屏名字(也是用例认它的名字)。 */
export const BACK_LABEL = '返回';

/**
 * 这一格此刻看不看得见 —— 返回键只交给看得见的那几格里开着的层(App.tsx 用它给每一格包 BackScope)。
 * 折叠屏展开 / 平板竖屏(styles.css 那个 `(orientation: portrait) and (min-width: 600px)` 断点)时
 * 事项一直在左栏,在事项页时舞台也并排露着。
 */
export function paneShown(pane: Page, page: Page, split: boolean): boolean {
  if (pane === page) return true;
  if (!split) return false;
  return pane === 'inbox' || (pane === 'stage' && page === 'inbox');
}

/** 壳此刻在画哪一屏(只取返回要看的那几格)。 */
export interface ShellScreen {
  /** 来电那一路:`idle` 以外(响铃 / 已接 / 话筒那一通)整屏都是电话。 */
  incoming: 'idle' | 'ringing' | 'answered' | 'handset';
  meeting: boolean;
  onboarding: boolean;
  page: Page;
}

/**
 * 壳那一层怎么接返回:
 *   - `stay`:接住、什么都不做(电话压得过一切,返回不挂断、不退后台);
 *   - `none`:壳不接 —— 会议页、引导自己接;首页上谁都不接就退到后台;
 *   - `home`:下一级回首页。
 *
 * 2026-09-25:座机页整个去掉了(卡 feat/first-look-orb-top),它那两档(`closeDeskOverlay` / `leaveDesk`)跟着去掉。
 */
export type ShellBack = 'none' | 'stay' | 'home';

export function shellBackOf(screen: ShellScreen): ShellBack {
  if (screen.incoming !== 'idle') return 'stay';
  if (screen.meeting || screen.onboarding) return 'none';
  return screen.page === 'stage' ? 'none' : 'home';
}
