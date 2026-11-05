/**
 * 设置页的分组与层级(2026-09-27,卡 SZ2;梳理见 docs/梳理-0927-手机设置页.md)。
 *
 * 以前设置是一条**没有分组的长卷**:十二节从上往下排,排的顺序是「谁先写的谁在上面」,
 * 于是她每天真会碰的那三件(免打扰时段、朗读、大字)在第五屏往后,而装一次就再也不碰的
 * (退出登录、房间凭证、令牌)霸着头几屏。这一份把它排成**八行**,按「她多久碰一次」从上往下:
 *   我的电脑 / 提醒与免打扰 / 声音与形象 / 规矩与学到的 / 座机 / 资讯偏好 / 关于与更新 / 高级。
 * (「规矩与学到的」2026-10-10 由「记住的规矩」改名:那一页里明说的规矩下面接着「它学到了什么」。)
 * 每一行进一个子页 —— 首屏一屏看完。
 *
 * 这个文件是**纯的**(不认 React):只放页名、分组表、每一组的一句人话。
 * 接线在 SettingsPage.tsx。
 *
 * 注:名字上还有四条**待拍板**(梳理第六节):「登录」要不要改叫「我的电脑 / 换一台电脑」、
 * 「高级」去不去、「资讯偏好」并不并进提醒、那只实体话筒两端叫什么。这一版**一个名字都不改**,
 * 只换它们在页上的位置与层级。
 */

/** 设置里的一层。首屏(分组列表)是 `undefined`,不在这张表里。 */
export type SettingsNode =
  | 'computer' | 'alerts' | 'voiceLook' | 'rules' | 'handset' | 'news' | 'about' | 'advanced'
  /** 两条配座机的多步流程:它们自己就是一整页(SubPage),不是「座机」那一页里的一节。 */
  | 'addHandset' | 'switchNetwork';

/** 首屏顶上那条返回头里的名字 —— 和以前一样(App.tsx 以前写死的那个)。 */
export const SETTINGS_ROOT_TITLE = '设置';

/** 每一层的页名(子页顶上那一条写的就是它)。 */
export const SETTINGS_TITLES: Record<SettingsNode, string> = {
  computer: '我的电脑',
  alerts: '提醒与免打扰',
  voiceLook: '声音与形象',
  rules: '规矩与学到的',
  handset: '座机',
  news: '资讯偏好',
  about: '关于与更新',
  advanced: '高级',
  addHandset: '添加座机',
  switchNetwork: '给座机换网络',
};

/** 首屏上的八行。顺序就是这个数组的顺序 —— **高级排最后**,平时不打开。 */
export const SETTINGS_GROUPS: readonly {
  readonly key: Exclude<SettingsNode, 'addHandset' | 'switchNetwork'>;
  /** 那一行下面那句人话。**不写内部的东西**(地址、端口、设备号一律不上屏)。 */
  readonly hint: string;
}[] = [
  { key: 'computer', hint: '这台手机连的是哪台电脑、在外面还连不连得上' },
  { key: 'alerts', hint: '什么事该响铃叫你、哪一段时间不出声' },
  { key: 'voiceLook', hint: '朗读、按住说话、它长什么样、字大一点' },
  { key: 'rules', hint: '你说过一次就处处算数的那些话,和它从你平时做法里学到的' },
  { key: 'handset', hint: '那只拿起听筒接电话的实体话筒' },
  { key: 'news', hint: '每天早上搜什么、播多久' },
  { key: 'about', hint: '版本、新版本、引导' },
  { key: 'advanced', hint: '平时不用打开' },
];
