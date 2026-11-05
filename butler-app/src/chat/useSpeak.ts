/**
 * 朗读事务官的回复:POST /tts → 音频 → 播放并驱动口型。
 * 只读真回复(ButlerSide.kind === 'reply'),而且只读**新出现的**那条——第一次打开时把已有的全标成读过,不从头念一遍。
 *
 * **「第一次打开」认的是「收到第一份真快照」,不是「渲染了第一次」**(2026-09-26,卡 QH,统筹拍板)。
 * 这两件事差了一拍,而那一拍就是 bug:界面挂出来的那一刻 `feed.state` 还是 `emptyState()`、一条回复都没有,
 * 于是「已有的全标成读过」标的是**空集**;第一份真快照一到,还开着的那几件事上的旧回答全成了「新出现的」,
 * 最新那条就被念出来 —— **每次打开 App 都念一遍上一条回答**(不只半夜,白天也一样,只是白天他不觉得被打扰)。
 * 统筹 09-26 定:不念(「他打开 App 是去看不是去听;念旧内容不合理;上面那行注释的意图本来就是不念」)。
 * 落法:`speakNewReplies` 多收一个 `arrived`(`api/protocol.ts` 的 `snapshotArrived`),
 * 没到之前**什么都不做** —— 既不念,也不把空集记成「已有的」。
 *
 * 503/404 → 语音不可用,界面上说「本机没有配语音」;过了 retryMs(缺省 60 秒)再有新回复就重新探一次
 * (2026-09-16:以前是永远不再试,Ben 配好密钥也得重装 App)。可用与否只看语音接口,不看形象。
 *
 * **免打扰时段不自动念**(2026-09-26,卡 QH)。09-26 00:19 冷启动 App,首页顶上就有「停止朗读」——
 * 半夜在念东西,而维护者的免打扰是 21:00–08:30。判断读服务端那一格(`/state.quiet`,见 chat/quietVoice.ts),
 * 这里**不自己算时段**。两条边界要看清:
 *   - 拦的只有 `speakNewReplies`(自己冒出来的那一声);**`speakText`(他点「重听」)一个字不拦** —— 那是他要听。
 *   - 拦掉的那几条**照旧记成「念过了」**:不然 08:30 一到,凌晨三点那条回复会突然被念出来。
 *
 * **通话中不自动念,挂断之后也不补念**(2026-10-13,卡 E,维护者拍板:「挂断后手机不许再出声;通话中也不该自顾自念」)。
 * 10-13 下午真机那一幕:他在电话里交代的事,豆包交回的那段回话一到聊天页就被念出来 —— 通话中也念
 * (粒子球不抖,说明走的是手机外放、不是通话音轨),挂断后接着念,像它还在汇报。
 * 两条边界与免打扰那一处**同形**:只拦 `speakNewReplies`,`speakText` 照念;拦掉的照旧记成「念过了」(挂了就不该再出声)。
 *
 * 还有一条是**时间差**:挂断那一刻 TTS 可能还在路上,`stopSpeaking` 停不到一段**还没开始放**的音频 ——
 * 那正是「挂断后接着念」。所以通话那条边界一变(开始 / 结束)、这一层一卸,就换一个代号(`liveRef`),
 * `await` 回来代号已经变了的那一段**不放**。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../session';
import type { ThreadMessage } from './chatModel';
import { playAudioBlob, stopSpeaking } from '../aiboo/lipsyncPlayer';
import { reduceVoiceAvailability, shouldTryVoice, VOICE_RETRY_MS, VOICE_UNAVAILABLE_TEXT, type VoiceAvailability } from '../api/voice';
import type { QuietView } from '../api/protocol';
import { quietActive } from './quietVoice';

/**
 * @param quiet 服务端算好的「此刻能不能出声」(`/state.quiet`)。**缺席按能出声算** ——
 *   老工作台没有这一格,那时一切照旧;宁可多念一句,也不替他把声音关掉让他以为 App 坏了。
 * @param inCall 此刻在一通电话里(来电接起 / 拨出 / 座机模式都算;来电响铃那一刻这一层压根没挂)。
 *   **通话中不自动念**,到的那几条照旧记成「念过了」—— 挂断后不补念。见文件头那一段。
 */
export function useSpeak(session: Session, enabled: boolean, avatarId: string | undefined, mouthRef: React.MutableRefObject<number>, retryMs: number = VOICE_RETRY_MS, quiet?: QuietView, inCall = false) {
  const [availability, setAvailability] = useState<VoiceAvailability>('unknown');
  const [speaking, setSpeaking] = useState(false);
  const spokenRef = useRef<Set<string> | null>(null);
  /**
   * 「这一声还算不算数」的代号。通话那条边界一变、这一层一卸就 +1:
   * `speak` 在打 TTS 之前记下它,音频回来时代号变了就**不放** —— 他已经挂了。
   */
  const liveRef = useRef(0);

  /**
   * 念一句。没念成时回**一句给他看的话**(2026-09-25,卡 S):自动朗读新回复时调用方不理它(不打扰);
   * 他自己点了「重听」却什么都没发生才是失真 —— 那时调用方把这一句摆出来(在外面:朗读要跟电脑连同一个 Wi-Fi 才有……)。
   */
  const speak = useCallback(async (key: string, text: string): Promise<string | undefined> => {
    const live = liveRef.current;
    if (!shouldTryVoice(availability, Date.now(), retryMs)) return availability !== 'unknown' && !availability.available ? availability.note : undefined;
    const result = await session.voice.tts(text, avatarId);
    // 2026-09-24:出了局域网,房间那条路本来就不带语音(二进制不走,见 channel/channelClient.ts)——那不是「本机没配」,不改判断。
    // 以前在外面收到一条回复就把语音判成「本机没有配语音」,麦克风键跟着灰掉,回到家里还灰着,说的也是错的那句。
    const direct = session.client.mode() === 'direct';
    if (result.ok || direct) setAvailability((cur) => reduceVoiceAvailability(cur, result));
    // 在外面:那一句是远程对等表里写好的(channel/remoteParity.ts);在家里没配:同麦克风键下面那一行。
    if (!result.ok) return direct && (result.kind === 'unavailable' || result.status === 404) ? VOICE_UNAVAILABLE_TEXT : result.error;
    /*
     * 这段音频是上一个代号的了(电话在这中间挂了 / 开了,或者这一层已经卸掉):**不放**。
     * `stopSpeaking` 停得了正在放的,停不了一段还在路上的 —— 不挡这一句就是「挂断后接着念」。
     */
    if (liveRef.current !== live) return undefined;
    setSpeaking(true);
    try {
      await playAudioBlob(result.data, (v) => { mouthRef.current = v; }, () => { mouthRef.current = 0; setSpeaking(false); });
    } catch {
      mouthRef.current = 0;
      setSpeaking(false);
    }
    spokenRef.current?.add(key);
    return undefined;
  }, [session, avatarId, availability, mouthRef, retryMs]);

  /**
   * 每次 thread 变化调一下:找出新出现的真回复,读最新那条。
   *
   * @param arrived 第一份真快照到了没有(`snapshotArrived(feed.state)`)。**缺省 true** 是给只喂 thread 的
   *   单元用例留的口;页面上必须把真值传进来 —— 见文件头「第一次打开认的是收到第一份真快照」。
   */
  const hushed = quietActive(quiet);
  const speakNewReplies = useCallback((thread: readonly ThreadMessage[], arrived = true) => {
    /**
     * 第一份真快照还没到:**什么都不做**。
     *
     * 关键在「也不记」:这一刻 thread 一定是空的,把它记成「已有的」就等于把空集当成历史 ——
     * 真快照一到,旧回答全成了新的,打开 App 就念一遍(那正是 09-26 撞出来的那一幕)。
     * 早退之后 `spokenRef` 还是 null,等真快照那一拍再把当时已有的标成念过。
     */
    if (!arrived) return;
    const replies = thread.filter((m) => m.butler.kind === 'reply' && m.taskId !== undefined);
    const keys = replies.map((m) => `${m.taskId}:${m.butler.text}`);
    if (spokenRef.current === null) {
      spokenRef.current = new Set(keys);
      return;
    }
    const fresh = keys.filter((k) => !spokenRef.current!.has(k));
    // 记在「念过了」里的这一步在下面那道门**之前** —— 免打扰、通话中拦掉的几条也要记上:
    // 不然 08:30 一到,凌晨三点那条回复会突然被念出来;挂断那一刻,电话里那几条会一起补念出来。
    for (const k of fresh) spokenRef.current.add(k);
    // `inCall`:通话中一声不出(维护者 10-13)。他点「重听」走的是 `speakText`,不经这道门。
    if (!enabled || hushed || inCall || fresh.length === 0) return;
    const latestKey = fresh[fresh.length - 1];
    const latest = replies[keys.lastIndexOf(latestKey)];
    void speak(latestKey, latest.butler.text);
  }, [enabled, hushed, inCall, speak]);

  const stop = useCallback(() => { stopSpeaking(); mouthRef.current = 0; setSpeaking(false); }, [mouthRef]);

  /**
   * 通话那条边界(2026-10-13):一通**结束**那一刻把正在念的掐掉 —— 维护者:「挂断后手机不许再出声」;
   * 一通**开始**那一刻也掐 —— 那一声是从手机外放出去的,电话已经接通了还在念上一条回答就是在插嘴。
   * 换代号是为了连带作废还在路上的那一段(见 `speak` 里那道门)。
   */
  const wasInCall = useRef(inCall);
  useEffect(() => {
    if (wasInCall.current === inCall) return;
    wasInCall.current = inCall;
    liveRef.current += 1;
    stop();
  }, [inCall, stop]);

  // 这一层卸掉(换页 / 来电响铃顶上来)也一样:正在放的停掉,还在路上的作废。
  useEffect(() => () => { liveRef.current += 1; stopSpeaking(); }, []);

  return { availability, setAvailability, speaking, speakNewReplies, speakText: speak, stop };
}
