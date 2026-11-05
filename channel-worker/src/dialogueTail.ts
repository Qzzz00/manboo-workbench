/**
 * 通话里最近几句话的尾巴(2026-09-23,引导答案的对话凭据门)。
 *
 * 工作台那边(workbench-plugin/src/server/onboardingConsent.ts)要**她问出口的那一句 + 他之后的回答**
 * 才肯把授权类的 key 记成「可以」、才肯收一题的必答项 —— 电脑那条路它自己从回合表里读,
 * 电话这条路它看不见,所以由工人在交答案时带上 `heard: { asked, reply }`。
 *
 * 取法与回合表那一侧逐字同源:他最后连着说的几句拼成 reply,那之前她最后说的一句是 asked。
 * 只收**说定了**的句子(字幕 final)。纯内存、只留最近 {@link TAIL_LIMIT} 句。
 */
export const TAIL_LIMIT = 12

export interface Heard {
  asked: string
  reply: string
}

export function createDialogueTail(limit = TAIL_LIMIT) {
  let lines: { role: 'me' | 'butler', text: string }[] = []
  return {
    add(role: 'me' | 'butler', text: string): void {
      const trimmed = text.trim()
      if (trimmed === '') return
      lines.push({ role, text: trimmed })
      if (lines.length > limit) lines = lines.slice(lines.length - limit)
    },
    /** 他一句都没说过 → undefined(工作台据此照样当「没有凭据」处理,见那边的 exchangeFor)。 */
    heard(): Heard | undefined {
      let end = -1
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]?.role === 'me') { end = i; break }
      }
      if (end < 0) return undefined
      let start = end
      while (start - 1 >= 0 && lines[start - 1]?.role === 'me') start -= 1
      const reply = lines.slice(start, end + 1).map(line => line.text).join('\n')
      /**
       * 她那一问**常常拆成几句出口**(09-23 第二轮真机:「……我得看一眼你放代码的那个目录,」
       * 下一句才是「可以吗?」)。只取最后一句,工作台只看到「可以吗?」,认不出问的是目录,
       * 一连 409 了六次,她只好一遍遍重问。所以 asked 取他这次开口之前、她**连着说的所有句子**。
       */
      let askedEnd = start - 1
      while (askedEnd >= 0 && lines[askedEnd]?.role !== 'butler') askedEnd -= 1
      if (askedEnd < 0) return { asked: '', reply }
      let askedStart = askedEnd
      while (askedStart - 1 >= 0 && lines[askedStart - 1]?.role === 'butler') askedStart -= 1
      const asked = lines.slice(askedStart, askedEnd + 1).map(line => line.text).join('\n')
      return { asked, reply }
    },
    reset(): void { lines = [] },
  }
}
