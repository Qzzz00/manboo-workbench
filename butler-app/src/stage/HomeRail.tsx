/**
 * 首页球下面那一排小图标(2026-10-03 傍晚,卡「首页两卡 + 一排图标」=**方案 B**)。
 *
 * 维护者 17:5x 看过示意图之后的原话:
 *
 * > 只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……
 * > 中间的球球还是要大的,这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。
 *
 * 于是首页从上到下是:球 / Live2D 形象区 → 字幕 → **这一排五颗图标** → 两张卡并排各占一半 → 输入条。
 * 五颗的顺序就是她报的顺序:未接来电 · 各家最近的对话 · 今天要做 · 最近一次通话 · 资讯。
 *
 * ## 这一排是从哪儿来的
 *
 * 当天下午那张卡(「首页侧边小图标」)把「未接来电」「各家最近的对话」两行搬成了球那一栏
 * **右上角一列**绝对定位的小图标。方案 B 把那一列**并进这一排** —— 维护者要的是一处,不是两处。
 * 样子(44px、透明底、`ba-scene__icon--sm`)、`aria-label` / `title`、长按飘名字那一套照旧;
 * 变的只有:竖排 → 横排、绝对定位 → 球那一栏里最后一格(在流里,`flex: 0 0 auto`)。
 *
 * **为什么现在可以进流**:那张卡里它非得绝对定位,是因为主列里挂着五张卡,球那一格(`flex: 1`)
 * 被挤得只剩 162px(412×915 真机),再占 44px 就更没球可看了。方案 B 把三张卡换成这一排:
 * 卡片区从三行网格掉到一行,省下来的那一大截全归球那一格(它是 `flex: 1`,自己吃掉),
 * 这一排占的 44px 跟它比是零头。量数在 docs/交接-1003-手机首页两卡一排图标.md。
 *
 * ## 名字怎么给(照旧,只换了飘在哪儿)
 *
 * 一行字就要回去占宽,这一排就摆不下五颗。所以名字走两条路:
 *   · 读屏 / 长按:`aria-label` 与 `title`(安卓长按原生 tooltip);
 *   · 长按 450ms:飘出那几个字(`.ba-rail__name`)。**这一版飘在整排正上方居中**(上一版飘在那一颗左边)——
 *     横排里第一颗的左边是屏幕边缘,`nowrap` 的名字会溢出去;挂在这一排上居中既不会被切,也不会把版面撑宽。
 *     长按之后那一下 click **不开页**(她是在问这是什么,不是要进去)。
 *
 * ## 角标只写数得出来的数
 *
 * 未接那颗与「今天要做」那颗各有一个角标,两个都是**这一份 /state 里数出来的**
 * (`missedShownCount` / `todayTasks().length`,与点开之后那一页 / 那一块列的是同一处);
 * **0 时不画角标,图标照旧在**。
 * 「各家最近的对话」「最近一次通话」两颗**不带角标**:
 * 真实条数要首页另去问一遍(`/sessions/history` 要 stat 各家的记录目录、读几十个文件的头尾),
 * 首页不为一个数干这件事。仓库那条规矩反过来也支持:数不出来就不写一个数,不编。数在那几页上。
 *
 * ## 资讯那颗:一个小点,不是数(2026-10-03 晚,卡 `claude/phone-news-podcast-dot`)
 *
 * 维护者被问「资讯那颗要不要一个角标」,选的是「要,只标播客有没有」:**今天那期播客能听时亮一个小点**,
 * 不写数字。能不能听由调用方给(StagePage 用 `glancePodcast`,与资讯那一页摆哪条播放条同一处判断);
 * 不亮时读屏照旧念「打开「资讯」」—— 不亮可能只是还没问到,不替她说「今天没有播客」。
 * 点是白的、不是琥珀:琥珀那两个数是「要你处理」那一档,播客是「有东西可听」,不催她。
 *
 * ## 第六颗:会议(2026-10-04,卡 `claude/phone-home-meeting-icon`)
 *
 * 维护者原话:「再开张卡,把会议模式一样拿出来到右边的侧边栏上」——「一样」指的就是 10-03
 * 把那两行搬成小图标那件事,而那一列在方案 B 里已经并进了这一排,所以它是**这一排里的第六颗**。
 * 在这之前会议只有一条路:记录 → 对话记录页 → 顶上那排小链接里的「会议」——**藏了三层**,
 * 她在手机上找不到。记录面板里那颗照旧留着(同另外几颗),是第二条路。
 *
 * **不带角标也不带小点**:录音在会议页卸载时就停了(App.tsx 那条早退的注释),首页上没有「正在录」
 * 这回事;纪要有几条首页不另去问一遍(同「各家最近的对话」那颗:数不出来就不写一个数)。
 * 顺序排在最后 —— 挪位置是 `items` 里一行的事。
 * **2026-10-10 起会前准备亮一个小点**(卡「会前画像与预案」):有一场待开的会在等她答一问、或者预案卡好了,
 * 这颗亮一个白点(不写数,同资讯那颗)—— 「开会前把画像和预案卡推到手机上」在手机上落在这里。
 *
 * ## 整排图标重选(2026-10-04,同一张卡)
 *
 * 维护者原话:「那排小按钮离下面的两张卡片太近了,而且图标的意思看着也很容易误解,
 * 你调整好间距,并且重新选一批 icon」;追一句:「未接来电和现在输入框的通话是同一个」。
 *
 * 规矩是**整页一起看、一个图只表达一个意思**(首页上同时画着的还有输入条那几颗与顶上那两颗):
 *   · 输入条那颗「打出去」留着不带记号的 `phone`(它是主动作),按住说话留着 `microphone`;
 *   · 于是这一排里 **未接来电 = `phone-off`**(话筒打叉 = 没接到)、**最近一次通话 = `phone-check`**
 *     (话筒打勾 = 打过的那一通)—— 三颗话筒按记号分,不再是「同一个图两个意思」;
 *   · **各家最近的对话 = `message-chatbot`**(气泡里一张机器人脸 = 各家 AI 的会话),
 *     与顶上那颗「记录」(`messages`,两层素气泡 = 和事务官的对话)分得开;
 *   · **今天要做 = `clipboard-check`**(写字板打勾 = 待办清单);
 *   · **资讯 = `file-text`**(一页文字 = 今天的资讯稿;能不能听由那颗小点说,不靠耳机图);
 *   · **会议 = `headset`**(头戴耳麦 = 开会那一套)。
 * 每一颗的备选与「为什么不会误解」在 docs/交接-1004-手机首页会议图标.md 那张表里。
 *
 * ## 这一排与下面两张卡之间的距离
 *
 * 原来只有 2px(这一排自己的 `padding-bottom`),图标下沿贴着卡片上沿 —— 维护者说「太近了」。
 * 现在走 `--ba-gap-rail-cards`(styles.css 顶上那一份变量里),量数在交接第四节。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MEETING_TITLE } from '../nav/navModel';
import { StageIcon, type IconName } from './icons';
import './homeRail.css';

/** 长按多久算「她在问这是什么」。 */
const HOLD_MS = 450;
/** 名字飘多久。 */
const NAME_MS = 1600;

/** 未接那颗一条都没有时点下去说的话(那时候不开那一块 —— 空着的一块等于在装作有东西)。 */
export const RAIL_MISSED_NONE_TEXT = '没有未接来电。她打过来而你没接到的,会记在这儿。';

/** 这一排里几颗的名字(用例与读屏都认它们;与到了之后那一页 / 那一块上看到的字一样)。 */
export const RAIL_MISSED_NAME = '未接来电';
export const RAIL_TODAY_NAME = '今天要做';
export const RAIL_CALLS_NAME = '最近一次通话';
export const RAIL_NEWS_NAME = '资讯';
/**
 * 会议那颗。**就是会议页返回头上那个字符串**(`navModel.MEETING_TITLE`)——
 * 不在这儿另写一个「会议」:读屏念的、长按飘的,与到了之后看到的必须是同一处。
 */
export const RAIL_MEETING_NAME = MEETING_TITLE;
/** 资讯那颗亮着小点时,读屏在名字后面念的那一句。 */
export const RAIL_NEWS_PODCAST_TEXT = '今天的播客能听了';
/** 会议那颗亮着小点时(2026-10-10):有一场待开的会在等她答一问,或者预案卡好了 —— 会前推到手机上的就是它。 */
export const RAIL_MEETING_PREP_TEXT = '有一场会的会前准备要看';

/** 这一排整体的读屏名字(`role="group"` 要一个,不然 generic 这个角色取不了名)。 */
export const HOME_RAIL_LABEL = '首页那一排入口';

export interface HomeRailProps {
  /** 未接来电那颗。`count` 为 0 时**图标照旧在**,只是不画角标。点开挂的是原来那一块(不是一页)。 */
  missed?: { count: number; onOpen(): void };
  /** 「各家最近的对话」那颗。名字由调用方给(与那一页的返回头同一个字符串)。 */
  history?: { name: string; onOpen(): void };
  /** 「今天要做」那颗(原来主列里那张卡)。`count` 为 0 时不画角标。 */
  today?: { count: number; onOpen(): void };
  /** 「最近一次通话」那颗(原来主列里那张卡):点开就是那张卡原来的去处。 */
  calls?: { onOpen(): void };
  /** 「资讯」那颗(原来主列里那张卡)。`podcast` = 今天那期播客能听 → 图标右上角亮一个小点(不写数)。 */
  news?: { podcast?: boolean; onOpen(): void };
  /**
   * 「会议」那颗(2026-10-04)。名字是 `RAIL_MEETING_NAME`(= 会议页返回头上那个字符串),
   * 不带角标、不带小点(理由在文件头)。缺席时这一颗整个不画。
   */
  meeting?: { prep?: boolean; onOpen(): void };
}

interface RailItem {
  name: string;
  icon: IconName;
  /** 读屏念的那一句(带数;没有数的那颗就是「打开「<名字>」」)。 */
  label: string;
  badge?: number;
  /** 只亮一个点、不写数(今天只有资讯那颗用:播客能听)。 */
  dot?: boolean;
  onOpen(): void;
}

/** 有数的那两颗:0 不画角标,读屏也照实念「一件都没有」。 */
function countLabel(name: string, count: number, none: string): string {
  return count > 0 ? `${name} ${count}` : `${name},${none}`;
}

function RailButton({ item, onHold, onRelease, onOpen }: {
  item: RailItem;
  onHold(name: string): void;
  onRelease(): void;
  onOpen(go: () => void): () => void;
}) {
  return (
    <button
      type="button"
      className="ba-scene__icon ba-scene__icon--sm ba-rail__btn"
      aria-label={item.label}
      title={item.name}
      onPointerDown={() => onHold(item.name)}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onPointerLeave={onRelease}
      onClick={onOpen(item.onOpen)}
    >
      <StageIcon name={item.icon} />
      {/* 角标:0 时整个不画(「未接来电 0」不是一条消息)。数念在 aria-label 里,这一颗不读。 */}
      {item.badge !== undefined && item.badge > 0 && (
        <span className="ba-rail__badge" aria-hidden="true">{item.badge > 99 ? '99+' : item.badge}</span>
      )}
      {/* 小点:念在 aria-label 里,这一颗不读。 */}
      {item.dot === true && <span className="ba-rail__dot" aria-hidden="true" />}
    </button>
  );
}

export function HomeRail({ missed, history, today, calls, news, meeting }: HomeRailProps) {
  /** 此刻在飘哪个名字(长按)。 */
  const [named, setNamed] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  /** 刚才那一下是长按:随后的 click 不开页。 */
  const held = useRef(false);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (named === null) return;
    const t = window.setTimeout(() => setNamed(null), NAME_MS);
    return () => window.clearTimeout(t);
  }, [named]);

  const release = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const hold = useCallback((name: string) => {
    held.current = false;
    release();
    timer.current = window.setTimeout(() => { timer.current = null; held.current = true; setNamed(name); }, HOLD_MS);
  }, [release]);
  /** 长按刚飘过名字 → 这一下不开页;别的照开。 */
  const open = useCallback((go: () => void) => () => {
    if (held.current) { held.current = false; return; }
    go();
  }, []);

  // 顺序就是维护者报的那个顺序。没有去处的那一颗整个不画(点了没反应比不能点更糟,D13)。
  const items: RailItem[] = [
    ...(missed === undefined ? [] : [{
      name: RAIL_MISSED_NAME,
      icon: 'phone-off' as const,
      label: countLabel(RAIL_MISSED_NAME, missed.count, '一条都没有'),
      badge: missed.count,
      onOpen: missed.onOpen,
    }]),
    ...(history === undefined ? [] : [{
      name: history.name,
      icon: 'message-chatbot' as const,
      label: `打开「${history.name}」`,
      onOpen: history.onOpen,
    }]),
    ...(today === undefined ? [] : [{
      name: RAIL_TODAY_NAME,
      icon: 'clipboard-check' as const,
      label: countLabel(RAIL_TODAY_NAME, today.count, '一件都没有'),
      badge: today.count,
      onOpen: today.onOpen,
    }]),
    ...(calls === undefined ? [] : [{
      name: RAIL_CALLS_NAME,
      icon: 'phone-check' as const,
      label: `打开「${RAIL_CALLS_NAME}」`,
      onOpen: calls.onOpen,
    }]),
    ...(news === undefined ? [] : [{
      name: RAIL_NEWS_NAME,
      icon: 'file-text' as const,
      label: news.podcast === true ? `${RAIL_NEWS_NAME},${RAIL_NEWS_PODCAST_TEXT}` : `打开「${RAIL_NEWS_NAME}」`,
      dot: news.podcast === true,
      onOpen: news.onOpen,
    }]),
    /*
     * 会议排在最后(2026-10-04)。`microphone` 是库里本来就有的那一个:会议页上最先出现的那一屏
     * 就是「在录」(大计时器 + 电平条),录音是她在手机上对这一页的全部期待。
     * 底下输入条那颗「按住说话」用的也是这个图,两处的分别在样子上(那颗是实心圆的发送键、
     * 这一排是 44px 透明底)与名字上(长按飘「会议」、读屏念「打开「会议」」)。
     */
    ...(meeting === undefined ? [] : [{
      name: RAIL_MEETING_NAME,
      icon: 'headset' as const,
      label: meeting.prep === true ? `${RAIL_MEETING_NAME},${RAIL_MEETING_PREP_TEXT}` : `打开「${RAIL_MEETING_NAME}」`,
      ...(meeting.prep === true ? { dot: true } : {}),
      onOpen: meeting.onOpen,
    }]),
  ];

  return (
    // `role="group"`:光一个 `aria-label` 挂在普通 div 上是会被读屏丢掉的(generic 这个角色不支持取名)。
    <div className="ba-rail" role="group" aria-label={HOME_RAIL_LABEL}>
      {/* 长按飘出来的那几个字:整排正上方居中、绝对定位、不占地方、不吃点击。 */}
      {named !== null && <span className="ba-rail__name" role="status">{named}</span>}
      {items.map((item) => (
        <RailButton key={item.name} item={item} onHold={hold} onRelease={release} onOpen={open} />
      ))}
    </div>
  );
}
