/** Only the user's current utterance can authorize replacing a draft or opening a new chat. */
export function relayIntent(said: string): { overwrite: boolean, newConversation: boolean, callBack: boolean } {
  const t = said.trim().replace(/[，。！!？?\s]+/g, '')
  const explicitReplace = /^(可以|允许|同意|确认|直接|把它|把原来的|把草稿)*(盖掉|覆盖|覆盖掉|覆盖草稿|覆盖原来的|替换草稿)(吧|就行|发送|然后发送)?$/.test(t)
    || /(?:你|给我|直接)(?:把它|把原来的|把草稿)?(?:盖掉|覆盖掉|覆盖草稿|覆盖原来的)/.test(t)
  /**
   * ★ **「回了打电话给我」—— 电话里只认她明说的那一句**(2026-10-04,卡 `claude/relay-call-optin`)。
   *
   * 手机上那是框旁边一个勾选,**电话里没有框**:所以口径是「她明说了才盯回电,否则不盯」
   * (缺省不盯,同手机上那个勾选的缺省)。判据与 `overwrite` / `newConversation` 同一条纪律 ——
   * **按她的原话判**,不按模型填的参数;说了不用就不算。
   */
  const callBack = !/(不要|别|不许|不用|不必|没让你).{0,8}(打电话|打给我|回电|告诉我|通知我)/.test(t)
    && /(?:回了|回复了|有回复|有了回复|有回音|回话了|答复了|有结果)(?:之后|以后|就|再|了)?(?:记得|麻烦)?(?:给我|跟我|和我)?(?:打个?电话|打给我|回个?电|回电|告诉我|说一声|叫我|通知我)/.test(t)
  return {
    overwrite: !/(不要|别|不许|不能|不用).{0,8}(盖掉|覆盖|替换)/.test(t)
      && !/[？?]|(?:能不能|是否|要不要)/.test(said) && explicitReplace,
    newConversation: !/(不要|别|不许|不用|没让你).{0,6}(新开|新建|开一|新工作任务)/.test(t)
      && /(?:点击|点开|打开)(?:那个|这个)?新工作任务|(?:新开|新建|开)(?:一个|一条|个|条)?(?:新的?)?(?:工作任务|任务|会话|对话|窗口|聊天)|^(?:我让你|让你|请你|你给我|给我|你)?(?:新开|新建)(?:一个|一条|个|条)?(?:新的?)?(?:吧|就行)?$/.test(t),
    callBack,
  }
}
