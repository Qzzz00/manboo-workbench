/**
 * 「她在屏上看到哪一句」:电脑对话框的回执、手机刚发出那一下的气泡。
 *
 * 两样都是界面里就地拼的(没有导出的函数可调),验收要的是**她看到的**那一句,不是 8791 回包里的 note ——
 * 10-22 盘点里「只记一笔在手机上显示成『已交给事务官』」就是这两者不一样。所以这里照着界面抄一份,
 * 抄的是哪几段由下面两张 `*_SOURCE_MARKS` 列着,对照用例逐条去源头文件里找;界面改了、这里没跟,用例红。
 * 手机气泡后面那一段(卡回来之后按卡的状态显示什么)不抄,`run.ts` 直接调手机自己的 `chatModel.ts`。
 */

/** `POST /butler/item` 回包里界面认的那几格。 */
export interface ItemAnswer {
  ok?: boolean
  id?: string
  note?: string
  error?: string
  carried_on?: boolean
  feedback?: unknown
  meeting_plan?: unknown
  publish_plan?: unknown
  today_view?: unknown
  file_ask?: unknown
  /** 「落地」口(卡 1a):事务官那一句(屏幕版)。 */
  say?: { screen?: string, spoken?: string }
  /** 「落地」口挂起确认(卡 1a):还没建卡,等她点头。 */
  ask?: { ask_id?: string, question?: string }
}

/** `workbench-plugin/src/client/ButlerInbox.tsx` 的 `submit` 里那几段。 */
export const DESK_RECEIPT_SOURCE_MARKS: readonly string[] = [
  'if (res.ok !== false && answer.ok === true) {',
  'setReceipt(answer.meeting_plan !== undefined',
  "? answer.note ?? '记下了这场会'",
  ': answer.feedback !== undefined',
  "? answer.note ?? '这是工作台本身的问题,我反馈给开发者了。'",
  ': answer.carried_on === true',
  "? '接着刚才那件说了'",
  ': (answer as { ask?: unknown }).ask !== undefined',
  "? answer.note ?? '这件等你点头我再办。'",
  ": answer.note === undefined ? '事项已建下' : `已建下,${answer.note}`)",
  "setReceipt(answer.error ?? '没建成')",
]

export function deskReceiptOf(answer: ItemAnswer, httpOk: boolean): string {
  if (httpOk && answer.ok === true) {
    return answer.meeting_plan !== undefined
      ? answer.note ?? '记下了这场会'
      : answer.feedback !== undefined
        ? answer.note ?? '这是工作台本身的问题,我反馈给开发者了。'
        : answer.carried_on === true
          ? '接着刚才那件说了'
          : answer.ask !== undefined
            ? answer.note ?? '这件等你点头我再办。'
            : answer.note === undefined ? '事项已建下' : `已建下,${answer.note}`
  }
  return answer.error ?? '没建成'
}

/** 手机刚送到那一下摆的那条(`butler-app/src/chat/chatModel.ts` 的 `PendingMessage` 里用得到的几格)。 */
export interface PhonePending {
  taskId?: string
  note?: string
  settled?: true
  fileAsk?: true
}

/** `useSendItem.deliveredOf` 的有序片段；完整返回值也要对照，不能只找到分支名。 */
export const PHONE_PENDING_SOURCE_MARKS: readonly string[] = [
  "if (path === SAY_PATH && (typeof (raw as SayCardPayload | undefined)?.say?.screen !== 'string' || (raw as SayCardPayload).say?.screen === '')) {",
  "return { pending: { ...base, error: '服务端 say 回包缺少 say.screen；没有按事项 ID 推断成功。' } };",
  'const fileAsk = parseFileAsk((raw as { file_ask?: unknown } | undefined)?.file_ask);',
  `if (fileAsk !== null) {
    const screen = (raw as SayCardPayload).say?.screen;
    return { fileAsk: { ...fileAsk, ...(typeof screen === 'string' && screen !== '' ? { screen } : {}) } };
  }`,
  'if (data.today_view !== undefined) {',
  "const line = typeof data.note === 'string' && data.note !== '' ? data.note : '换好了。';",
  'return { pending: { ...base, note: line, settled: true }, refresh: true };',
  'if (data.meeting_plan !== undefined) {',
  "const line = typeof data.note === 'string' && data.note !== '' ? data.note : '记下了这场会。';",
  'return { pending: { ...base, note: `${line}${MEETING_PLAN_WHERE}`, settled: true }, refresh: true };',
  'if (data.publish_plan !== undefined) {',
  "const line = typeof data.note === 'string' && data.note !== '' ? data.note : '记进发布计划了。';",
  'return { pending: { ...base, note: line, settled: true }, refresh: true };',
  'if (data.feedback !== undefined) {',
  "const line = typeof data.note === 'string' && data.note !== '' ? data.note : '这是工作台本身的问题,我反馈给开发者了。';",
  'return { pending: { ...base, note: line, settled: true } };',
  "if (data.carried_on === true) return { pending: { ...base, note: '接着刚才那件说了' }, refresh: true };",
  'const sayScreen = (raw as { say?: { screen?: unknown } | undefined } | undefined)?.say?.screen;',
  "if (typeof sayScreen === 'string' && sayScreen !== '') {",
  'const returnedItems = (raw as SayCardPayload).items ?? [];',
  "const ids = returnedItems.flatMap(item => typeof item.card_id === 'string' ? [item.card_id] : []);",
  "const allItemsHaveCards = returnedItems.length > 0 && returnedItems.every(item => item.status === 'done' && typeof item.card_id === 'string');",
  'return { pending: { ...base, ...(!allItemsHaveCards ? {} : { taskIds: ids }), note: sayScreen, sayCards: raw as SayCardPayload }, refresh: true };',
  "if (typeof data.id === 'string' && data.id !== '') return { pending: { ...base, taskId: data.id }, refresh: true };",
  "return { pending: { ...base, note: '送到了' }, refresh: true };",
]

/** 会议那一档后面接的那句(`useSendItem.ts` 导出的 `MEETING_PLAN_WHERE`;这里只为拼出同一句,run.ts 会换成真常量)。 */
export function phonePendingOf(answer: ItemAnswer, meetingWhere = ''): PhonePending {
  const noteOr = (fallback: string): string => (typeof answer.note === 'string' && answer.note !== '' ? answer.note : fallback)
  if (answer.file_ask !== undefined && answer.file_ask !== null) return { fileAsk: true }
  if (answer.today_view !== undefined) return { note: noteOr('换好了。'), settled: true }
  if (answer.meeting_plan !== undefined) return { note: `${noteOr('记下了这场会。')}${meetingWhere}`, settled: true }
  if (answer.publish_plan !== undefined) return { note: noteOr('记进发布计划了。'), settled: true }
  if (answer.feedback !== undefined) return { note: noteOr('这是工作台本身的问题,我反馈给开发者了。'), settled: true }
  if (answer.carried_on === true) return { note: '接着刚才那件说了' }
  // 「落地」口(卡 1a):回包里带事务官那一句就摆它(与 useSendItem.deliveredOf 同一分支)。
  if (typeof answer.say?.screen === 'string' && answer.say.screen !== '') return { note: answer.say.screen }
  if (typeof answer.id === 'string' && answer.id !== '') return { taskId: answer.id }
  return { note: '送到了' }
}
