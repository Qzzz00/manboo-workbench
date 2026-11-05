/**
 * 扬声器独占仲裁——同一时刻只允许一个发声者（TTS 播报 / 哼唱 / 通话）。
 * 不做这层的话，哼到一半来条消息，TTS 播报会和哼声叠在一起。
 *
 * 铁律 1：**喊停时新占用者还没上任**。acquireVoice 会先把 current 清空、再去调旧的
 * stop、最后才装上新占用者——这样旧 stop 回调里若调 releaseVoice，看到的 current
 * 要么是 null 要么已被清空，不可能命中刚装上的新占用者。
 *
 * 这一步不能简化成「先把 current 换成新占用者再喊停」：owner 只是个字符串标签，
 * releaseVoice 按名字匹配。真实场景里 tts.ts 每次 acquireVoice('tts', stopSpeaking)
 * 传的都是同一个函数引用，而 stopSpeaking 自己也会 releaseVoice('tts')——如果新占用者
 * 已经提前换上（同样叫 'tts'），旧 stop 回调这声 release 就会把刚上任、同名的新占用者
 * 一起误清掉（voiceChannel.test.ts 里★标的同名连续 acquire 用例专门锁住这个场景）。
 *
 * 铁律 2：**owner 名字不是身份**。'tts' 这种名字会被同一个 owner 反复使用——连播两句、
 * 前一句被打断后一句立刻顶上。旧会话「迟到」的终止回调（比如异步事件晚落地：浏览器
 * TTS 被 speechSynthesis.cancel() 打断后仍会落地的 onend/onerror，或 <audio>.src=''
 * 触发的 onerror）如果只按名字 release，会误清「当前这个同名但完全不同」的新会话。
 * 所以 acquireVoice 会发一个自增 token 作身份凭证；release 时可以附带这个 token 一起
 * 校验——必须是「当前这个 entry 确实是我当初抢到的那个」才清，不是「刚好也叫这个名字」
 * 就清。不传 token 时退化为纯按名字匹配（向后兼容旧调用方、以及「拦停当前无论是谁」
 * 这种就是要按名字操作的场景，比如 stopSpeaking 直接调用时）。
 *
 * 铁律 3：**stop 回调期间的嵌套 acquire 不能被静默吃掉**。旧占用者的 stop 回调里，如果
 * 又发起了一次新的 acquireVoice（比如 stateListener 在「TTS 刚变 idle」那一刻同步抢了
 * 麦），那个嵌套 acquire 装上的 entry 不能被外层这次 acquire 无条件覆盖——覆盖了却不
 * 喊停，等于让那个嵌套占用者以为自己占着，永远等不到自己的 stop。acquireVoice 因此在
 * 自己那声 stop 调用完之后，会循环排空（drain）任何这样被嵌套装上的 entry——逐个喊停，
 * 直到没有人再插队，才轮到这次真正要装的新占用者。用循环而不是判一次：嵌套本身也可能
 * 再嵌套（每一层被顶替的 stop 都得跑到），只判一次会漏掉更深的那一层。
 */

export type VoiceOwner = 'tts' | 'singing' | 'rtc';

/** acquireVoice 返回的不透明身份凭证，配合 releaseVoice 做「这是不是我这次抢到的」校验。 */
export type VoiceToken = number;

type Entry = { owner: VoiceOwner; stop: () => void; token: VoiceToken };

let current: Entry | null = null;
let nextToken: VoiceToken = 1;

/**
 * 铁律 3 的 drain 循环上限。今天没有占用方会在自己的 stop 回调里再 acquire（tts/singing
 * 的 stop 都只 release），所以这个上限打不到；但模块顶部的注释是在**鼓励**嵌套 acquire，
 * 而这个循环的推进完全由外部回调决定——一个「stop 里又抢麦」的占用方就能让它永不收敛。
 * 那个失败模式（同步死循环冻住 UI 线程）比它取代的泄漏严重得多，所以封顶：到顶就告警
 * 退出，让本次 acquire 正常装上新占用者——丢一次交接，好过整个界面卡死。
 * 32 远高于任何合理的嵌套深度（真实值是 0）。
 */
const MAX_DRAIN_ITERATIONS = 32;

function stopQuietly(entry: Entry | null): void {
  if (!entry) return;
  try {
    entry.stop();
  } catch {
    // 停旧的失败不该拖垮新的
  }
}

export function acquireVoice(owner: VoiceOwner, stop: () => void): VoiceToken {
  const prev = current;
  current = null;
  stopQuietly(prev);
  // 铁律 3：排空 stop 回调期间任何嵌套 acquire 装上的 entry——逐个喊停，直到没人插队。
  let drained = 0;
  while (current !== null) {
    // 显式标注类型：current 是模块级 let，TS 的控制流分析看不见 stopQuietly 回调里对它的
    // 重新赋值，从第二轮起会把它误缩窄成 never（于是读 .owner 报错）。
    const nested: Entry = current;
    if (drained >= MAX_DRAIN_ITERATIONS) {
      console.warn(
        `[voiceChannel] 嵌套 acquire 排空超过 ${MAX_DRAIN_ITERATIONS} 轮仍未收敛，`
        + `强制退出以免冻住主线程（最后插队者：${nested.owner}）`,
      );
      break;
    }
    drained += 1;
    current = null;
    stopQuietly(nested);
  }
  const token = nextToken++;
  current = { owner, stop, token };
  return token;
}

export function releaseVoice(owner: VoiceOwner, token?: VoiceToken): void {
  if (!current || current.owner !== owner) return;
  // 铁律 2：传了 token 就必须精确匹配「当前这个 entry」，不能只认 owner 名字。
  if (token !== undefined && current.token !== token) return;
  current = null;
}

export function currentVoiceOwner(): VoiceOwner | null {
  return current?.owner ?? null;
}

export function isVoiceBusy(): boolean {
  return current !== null;
}

export function stopCurrentVoice(): void {
  const prev = current;
  current = null;
  stopQuietly(prev);
}

/** 仅测试用：重置模块级状态。 */
export function __resetVoiceChannel(): void {
  current = null;
  nextToken = 1;
}
