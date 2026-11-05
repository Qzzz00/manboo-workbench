/**
 * ★ **推那一条答案通知的薄接线**(2026-10-04,卡 `claude/answer-comes-to-her`)。
 *
 * 判断在 `answerNotice.ts`(纯函数,四道门);这里只做三件事:
 *   ① 读「App 这会儿在前台吗」(`document.visibilityState` —— 这一份代码库里就用它,
 *      见 `useNewsGlance`:Capacitor 的 WebView 退到后台时它就是 `hidden`);
 *   ② 推那一下(原生插件的 `startRinging({ silent: true })`,理由与代价写在 `answerNotice.ts` 文件头);
 *   ③ 记住推过哪几条,不在她通知栏里响第二次。
 *
 * **绝不抛**:浏览器里调试、插件没装上时 `startRinging` 会抛(同 `deskPhone.ts` 那条规矩),
 * 那时就只是没通知 —— 答案照旧在 `/state.answers` 里,进 App 就在字幕上。
 */
import { useEffect, useRef, useState } from 'react';
import type { AnswersView } from '../api/protocol';
import { startRinging } from '../deskphone/deskPhone';
import { answerNoticeFor } from './answerNotice';

export function useAnswerNotice(answers: AnswersView | undefined, options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled !== false;
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  /** 推过的那几条。**用 ref**:它变了不该重渲染这一页。 */
  const notified = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onVisible = (): void => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const notice = answerNoticeFor({ answers, foreground: !hidden, notified: notified.current });
    if (notice === undefined) return;
    // 先记上再推:推那一下是异步的,不记就会在下一拍再推一次同一条。
    notified.current.add(notice.id);
    void startRinging({
      callId: `answer:${notice.id}`,
      title: notice.title,
      text: notice.body,
      // ★ 这一格是关键:**只发一条普通通知**,不响铃、不震、不拉起来电页。
      silent: true,
    }).catch(() => {
      // 推不出去(浏览器里、插件没装上):让它能再试一次 —— 她下一次切后台时还该收到。
      notified.current.delete(notice.id);
    });
  }, [answers, hidden, enabled]);
}
