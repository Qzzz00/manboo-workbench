/**
 * 文件拖放归工作台(2026-09-25,卡 fix/shell-web-capabilities)。
 *
 * 维护者 09-24 20:00:「我尝试拖拽一些文件,直接显示不支持」。
 *
 * **根因不在壳,在网页这一层**:DSH 上游的 AppFrame 永远挂着对话栏(ui-layout README:
 * 「AppFrame always mounts the conversation and details columns」),工作台浮层(`shell.overlay`)
 * 只是盖在它上面。对话栏里的附件组件(ui-attachment `ComposerAttachments`)在 **document** 上
 * 挂了一整页的文件拖放:
 *   - dragenter:整屏盖一层 DropOverlay,模型不看图时写「当前无法添加图片」——他看到的「不支持」;
 *   - dragover:`dropEffect = canAcceptDrop ? 'copy' : 'none'`。document 是冒泡的最后一站,
 *     这一下**覆盖**掉工作台输入框刚设好的接收,松手根本落不到输入框上;
 *   - drop:能收图时把图塞进**它自己**那个被盖住、看不见的草稿里。
 * Chrome 里一模一样(同一份网页代码),只是之前没人在壳外拖过文件。
 *
 * 做法:工作台浮层开着的时候,在 `<html>` 上(冒泡里排在 document 前一站)截住**带文件**的拖放,
 * 不再往 document 传 —— 上游那套看不见、也碰不到;工作台自己的落点(输入框、粒子设置)在更里层,
 * 照常先收到、先接住。没有落点接住的地方明确回「这里放不下」(dropEffect none),浏览器也就不会
 * 把文件当网页打开(壳那边另有一道:WebPolicy 不许主框架导航到 file:)。浮层一关(进了 DSH 原生
 * 会话页)立刻拆掉,上游的拖图照常能用。
 *
 * 只认带文件的拖放(`dataTransfer.types` 含 'Files')。页面内部的拖(看板卡片、标签排序)一个不碰。
 * 在真 WebKit 里的实测(复现上游截走 + 装上之后输入框收到文件)见 workbench-app/run-web-tests.sh。
 */

const FILE_DRAG_EVENTS = ['dragenter', 'dragover', 'dragleave', 'drop'] as const

/** 这一次拖的是不是文件(Finder / 桌面 / 别的 App 拖来的)。 */
export function carriesFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  const types = dataTransfer?.types as ArrayLike<string> | null | undefined
  if (types === null || types === undefined) return false
  // FrozenArray(现在的浏览器)与 DOMStringList(老 WebKit)都能 Array.from。
  return Array.from(types).includes('Files')
}

/**
 * 装上;回拆掉的函数。装在 `doc.documentElement` 的冒泡阶段:
 * - 带文件的四种拖放事件一律 `stopPropagation()` —— 到不了 document,上游那套不响;
 * - dragover 还没被谁接住(`defaultPrevented` 为假)→ 接住并回 `dropEffect = 'none'`:
 *   「这里放不下」,不出加号、松手不落、不开文件;
 * - drop 还没被谁接住 → `preventDefault()`,浏览器不把文件当网页打开。
 */
export function installFileDropGuard(doc: Document): () => void {
  const root = doc.documentElement
  if (root === null) return () => {}
  const onFileDrag = (event: Event): void => {
    const dataTransfer = (event as DragEvent).dataTransfer
    if (!carriesFiles(dataTransfer)) return
    event.stopPropagation()
    if (event.defaultPrevented) return // 工作台自己的落点已经接住了
    if (event.type === 'dragover') {
      event.preventDefault()
      if (dataTransfer !== null && dataTransfer !== undefined) dataTransfer.dropEffect = 'none'
    }
    else if (event.type === 'drop') {
      event.preventDefault()
    }
  }
  for (const type of FILE_DRAG_EVENTS) root.addEventListener(type, onFileDrag)
  return () => {
    for (const type of FILE_DRAG_EVENTS) root.removeEventListener(type, onFileDrag)
  }
}
