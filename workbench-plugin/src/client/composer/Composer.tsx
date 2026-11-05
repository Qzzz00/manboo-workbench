/**
 * 统一输入框(2026-09-24,docs/设计-统一输入框-2026-09-24.md)。
 *
 * 维护者:「你之前做的输入框(引导和事务官、手机和电脑端)都不是同一套,应该是同一套的不同裁剪才对;
 * 也说明我们现在没有加号、没有模型切换、没有模式选择」。
 *
 * 一个组件,裁剪见 composerModel.ts 的 TRIMS。长相照参考图:深色圆角大底座,左下「+」圆钮,
 * 右下两枚下拉胶囊(模式、模型),最右一颗白底黑字的圆形发送键;底座一圈中性单色的光沿边
 * (平时一圈静态细边,在想 / 交办在路上时光才走)。
 *
 * 草稿的**正文**由上层持有(事务官档切走再切回来不丢,沿用 2026-08-26 的决定);
 * 片(谁来办、附件、引用)归这个组件自己 —— 档是 display:none 不卸载,片也不会丢。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import type { ComposerAgentView, ComposerCurrentView, ComposerMode, ComposerOptionsView } from '../../protocol.ts'
import { FxBeam } from '../fx/Fx.tsx'
import type { BeamSpec } from '../fx/fxModel.ts'
import { fetchComposerOptions, saveComposerChoice, uploadComposerFile } from './composerApi.ts'
import {
  EMPTY_DRAFT, TRIMS, atQuery, canSend, dropAtQuery, filesOf, filterAgents, handLine, isSendKey, modeTitle, modelSeesImages,
  type ComposerDraft, type ComposerTrim, type DraftAttachment,
} from './composerModel.ts'

type Menu = 'plus' | 'refs' | 'at' | 'mode' | 'model'

export interface ComposerProps {
  trim: ComposerTrim
  /** 正文(上层持有)。 */
  text: string
  onTextChange: (next: string) => void
  /**
   * 发出去。回 true = 服务端接住了 → 清掉片(正文由上层自己清);false = 没接住,片与正文都留着。
   */
  onSubmit: (draft: ComposerDraft) => Promise<boolean>
  /** 在路上(发送键转圈、禁用)。 */
  busy?: boolean
  /** 光沿边走不走(由上层按「一屏最多一种强效果」判好)。 */
  glow?: boolean
  fxName: string
  fxSpec: BeamSpec
  placeholder: string
  ariaLabel: string
  sendLabel: string
  /** 胶囊上此刻写什么(/state.composer)。 */
  current?: ComposerCurrentView | undefined
  baseUrl?: string
  fetchImpl?: typeof fetch
  inputRef?: Ref<HTMLTextAreaElement>
  onFocus?: () => void
  onBlur?: () => void
  /** 底座下面的一行(提示、出口)。 */
  footer?: ReactNode
  /** 最少几行(引导 1、事务官 2)。 */
  rows?: number
}

function Chevron() {
  return <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export function Composer(props: ComposerProps) {
  const {
    trim, text, onTextChange, onSubmit, busy = false, glow = false, fxName, fxSpec, placeholder, ariaLabel, sendLabel,
    current, baseUrl, fetchImpl, inputRef, onFocus, onBlur, footer, rows = 2,
  } = props
  const spec = TRIMS[trim]
  const [draft, setDraft] = useState<Omit<ComposerDraft, 'text'>>({ attachments: [], refs: [] })
  const [menu, setMenu] = useState<Menu | undefined>(undefined)
  const [options, setOptions] = useState<ComposerOptionsView | undefined>(undefined)
  const [optionsNote, setOptionsNote] = useState<string | undefined>(undefined)
  const [atState, setAtState] = useState<{ start: number, query: string } | undefined>(undefined)
  const [highlight, setHighlight] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  /** 刚在下拉里选的(/state 还没带回来之前先显示它)。 */
  const [picked, setPicked] = useState<{ mode?: ComposerMode, model?: { provider: string, id: string, title: string, images: boolean } }>({})
  const fileRef = useRef<HTMLInputElement | null>(null)
  const localInput = useRef<HTMLTextAreaElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canNetwork = baseUrl !== undefined && fetchImpl !== undefined

  const full: ComposerDraft = {
    ...EMPTY_DRAFT,
    ...draft,
    text,
    ...(picked.mode === undefined ? {} : { mode: picked.mode }),
    ...(picked.model === undefined ? {} : { model: { provider: picked.model.provider, id: picked.model.id } }),
  }
  const sendable = canSend(full) && !busy
  const mode = picked.mode ?? current?.mode ?? options?.mode
  const model = picked.model ?? current?.model
  const seesImages = model?.images ?? modelSeesImages(options, undefined)

  // /state 带回来的跟刚选的一致了,本地那份就可以放掉。
  useEffect(() => {
    if (picked.mode !== undefined && current?.mode === picked.mode) setPicked(({ mode: _m, ...rest }) => rest)
    if (picked.model !== undefined && current?.model?.id === picked.model.id && current.model.provider === picked.model.provider) setPicked(({ model: _m, ...rest }) => rest)
  }, [current, picked])

  // 点外面收起菜单。
  useEffect(() => {
    if (menu === undefined) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) setMenu(undefined)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  async function loadOptions(): Promise<ComposerOptionsView | undefined> {
    if (!canNetwork) return undefined
    const got = await fetchComposerOptions(baseUrl, fetchImpl)
    if ('error' in got || !Array.isArray((got as ComposerOptionsView).agents)) {
      setOptionsNote('error' in got ? got.error : '菜单没拉到')
      return undefined
    }
    setOptions(got)
    setOptionsNote(undefined)
    return got
  }

  function openMenu(next: Menu): void {
    if (menu === next) { setMenu(undefined); return }
    setMenu(next)
    setHighlight(0)
    // 每次点开都现拉一次:@ 的候选是实时的(窗口槽里刚加了一家,下一次点开就该在)。
    void loadOptions()
  }

  function setRefInput(el: HTMLTextAreaElement | null): void {
    localInput.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef !== undefined && inputRef !== null) (inputRef as { current: HTMLTextAreaElement | null }).current = el
  }

  function addFiles(files: readonly File[]): void {
    if (!spec.plus || files.length === 0) return
    if (!canNetwork) { setNote('这里传不了文件'); return }
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const image = file.type.startsWith('image/')
      let preview: string | undefined
      try { preview = image && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined } catch { preview = undefined }
      const pending: DraftAttachment = { key, name: file.name === '' ? '截图' : file.name, image, ...(preview === undefined ? {} : { preview }) }
      setDraft(d => ({ ...d, attachments: [...d.attachments, pending] }))
      void uploadComposerFile(baseUrl, fetchImpl, file).then((result) => {
        setDraft(d => ({
          ...d,
          attachments: d.attachments.map(one => one.key !== key
            ? one
            : result.ok ? { ...one, name: result.view.name, view: result.view } : { ...one, error: result.error }),
        }))
      })
    }
  }

  function removeAttachment(key: string): void {
    setDraft(d => ({ ...d, attachments: d.attachments.filter(one => one.key !== key) }))
  }

  function pickAgent(agent: ComposerAgentView): void {
    if (agent.family === 'dsh') {
      setDraft(({ agent: _a, ...rest }) => rest)
      setNote(undefined)
    } else {
      const why = agent.ready ? undefined : (agent.hands.find(h => !h.ready)?.why ?? agent.hands[0]?.why ?? '尚未就绪')
      setDraft(d => ({ ...d, agent: { family: agent.family, title: agent.title, ready: agent.ready, ...(why ? { why } : {}) } }))
      if (!agent.ready) setNote(why)
      else setNote(undefined)
    }
    if (atState !== undefined) {
      const caret = localInput.current?.selectionStart ?? text.length
      onTextChange(dropAtQuery(text, atState.start, caret))
      setAtState(undefined)
    }
    setMenu(undefined)
    localInput.current?.focus()
  }

  function pickMode(next: ComposerMode): void {
    setPicked(p => ({ ...p, mode: next }))
    setMenu(undefined)
    if (canNetwork) void saveComposerChoice(baseUrl, fetchImpl, { mode: next })
  }

  function pickModel(next: ComposerOptionsView['models'][number]): void {
    setPicked(p => ({ ...p, model: { provider: next.provider, id: next.id, title: next.title, images: next.images } }))
    setMenu(undefined)
    if (canNetwork) void saveComposerChoice(baseUrl, fetchImpl, { model: { provider: next.provider, id: next.id } })
  }

  async function submit(): Promise<void> {
    if (!sendable) {
      if (full.agent?.ready === false) {
        setNote(full.agent.why ?? '该候选尚未就绪，无法发送')
      }
      return
    }
    setNote(undefined)
    const accepted = await onSubmit(full)
    if (accepted) {
      for (const one of draft.attachments) { if (one.preview !== undefined) { try { URL.revokeObjectURL(one.preview) } catch { /* 不要紧 */ } } }
      setDraft({ attachments: [], refs: [] })
    }
  }

  function onChangeText(next: string, caret: number): void {
    onTextChange(next)
    if (!spec.at) return
    const found = atQuery(next, caret)
    setAtState(found)
    if (found !== undefined) {
      if (menu !== 'at') { setMenu('at'); setHighlight(0); if (options === undefined) void loadOptions() }
    }
    else if (menu === 'at') setMenu(undefined)
  }

  const atList = options === undefined ? [] : filterAgents(options.agents, atState?.query ?? '')

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menu === 'at' && atList.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight(h => (h + 1) % atList.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight(h => (h - 1 + atList.length) % atList.length); return }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        const target = atList[Math.min(highlight, atList.length - 1)]
        if (target !== undefined) pickAgent(target)
        return
      }
    }
    if (event.key === 'Escape' && menu !== undefined) { event.preventDefault(); setMenu(undefined); return }
    if (isSendKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
      event.preventDefault()
      void submit()
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (!spec.plus) return
    const files = filesOf(event.clipboardData?.files)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const dropProps = spec.plus
    ? {
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
          event.preventDefault()
          // 明说是「复制进来」:不写的话壳(WebKit)按 Finder 给的操作挑成「移动」,光标上没有绿色加号
          // (2026-09-25 真引擎实测,workbench-app/run-web-tests.sh)。
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
          if (!dragging) setDragging(true)
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDragging(false)
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          const files = filesOf(event.dataTransfer?.files)
          setDragging(false)
          if (files.length === 0) return
          event.preventDefault()
          addFiles(files)
        },
      }
    : {}

  const chips = draft.agent !== undefined || draft.attachments.length > 0 || draft.refs.length > 0

  return (
    <div className="wb-cmp" data-trim={trim} data-dragging={dragging} ref={rootRef} {...dropProps}>
      {menu !== undefined && (
        <div className="wb-cmp__menu" role="menu" aria-label={menu === 'at' ? '交给谁' : menu === 'mode' ? '模式' : menu === 'model' ? '模型' : menu === 'refs' ? '引用' : '添加'}>
          {optionsNote !== undefined && menu !== 'plus' && <p className="wb-cmp__menu-note">{optionsNote}</p>}
          {menu === 'plus' && (
            <>
              <button type="button" role="menuitem" className="wb-cmp__item" onClick={() => { setMenu(undefined); fileRef.current?.click() }}>
                <span className="wb-cmp__item-title">加文件 / 图片</span>
                <span className="wb-cmp__item-hint">也可以直接粘贴,或者拖进来</span>
              </button>
              <button type="button" role="menuitem" className="wb-cmp__item" onClick={() => { setMenu('refs'); void loadOptions() }}>
                <span className="wb-cmp__item-title">引用一个事项或项目</span>
                <span className="wb-cmp__item-hint">把它现在的状态一起交代过去</span>
              </button>
              <button type="button" role="menuitem" className="wb-cmp__item" disabled>
                <span className="wb-cmp__item-title">录音 / 会议</span>
                <span className="wb-cmp__item-hint">在手机首页点「会议」开;电脑还没有收音</span>
              </button>
              <button type="button" role="menuitem" className="wb-cmp__item" onClick={() => { setMenu('at'); setAtState(undefined); void loadOptions() }}>
                <span className="wb-cmp__item-title">指定谁来办</span>
                <span className="wb-cmp__item-hint">也可以直接打 @</span>
              </button>
            </>
          )}
          {menu === 'refs' && (options?.recent.length === 0
            ? <p className="wb-cmp__menu-note">还没有能引用的事项或项目</p>
            : (options?.recent ?? []).map(ref => (
              <button key={`${ref.kind}-${ref.id}`} type="button" role="menuitem" className="wb-cmp__item" onClick={() => {
                setDraft(d => (d.refs.some(one => one.kind === ref.kind && one.id === ref.id) ? d : { ...d, refs: [...d.refs, { kind: ref.kind, id: ref.id, title: ref.title }] }))
                setMenu(undefined)
              }}>
                <span className="wb-cmp__item-title">{ref.kind === 'item' ? '事项' : '项目'} · {ref.title}</span>
                {ref.note !== undefined && <span className="wb-cmp__item-hint">{ref.note}</span>}
              </button>
            )))}
          {menu === 'at' && atList.map((agent, index) => (
            <button key={`${agent.family}:${agent.title}:${index}`} type="button" role="menuitem" className="wb-cmp__item" data-ready={agent.ready} data-active={index === highlight} onMouseDown={event => event.preventDefault()} onClick={() => pickAgent(agent)}>
              <span className="wb-cmp__item-title">{agent.title}{agent.in_slot ? <span className="wb-cmp__tag">窗口槽里</span> : null}</span>
              <span className="wb-cmp__item-hint">{handLine(agent)}</span>
            </button>
          ))}
          {menu === 'mode' && (options?.modes ?? []).map(one => (
            <button key={one.id} type="button" role="menuitemradio" aria-checked={one.id === mode} className="wb-cmp__item" onClick={() => pickMode(one.id)}>
              <span className="wb-cmp__item-title">{one.title}</span>
              <span className="wb-cmp__item-hint">{one.hint}</span>
            </button>
          ))}
          {menu === 'model' && (
            <>
              {options?.models_note !== undefined && <p className="wb-cmp__menu-note">{options.models_note}</p>}
              {(options?.models ?? []).map(one => (
                <button key={`${one.provider}/${one.id}`} type="button" role="menuitemradio" aria-checked={one.id === model?.id && one.provider === model?.provider} className="wb-cmp__item" onClick={() => pickModel(one)}>
                  <span className="wb-cmp__item-title">{one.id}</span>
                  <span className="wb-cmp__item-hint">{one.images ? '能直接看图' : '只看文字(图片给它路径)'}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <FxBeam name={fxName} spec={fxSpec} active={glow}>
        <form
          className="wb-cmp__box"
          data-glow={glow}
          onSubmit={(event) => { event.preventDefault(); void submit() }}
        >
          {chips && (
            <div className="wb-cmp__chips">
              {draft.agent !== undefined && (
                <span className="wb-cmp__chip" data-kind="agent">
                  @{draft.agent.title}
                  <button type="button" aria-label={`不交给${draft.agent.title}`} onClick={() => setDraft(({ agent: _a, ...rest }) => rest)}>×</button>
                </span>
              )}
              {draft.attachments.map(one => (
                <span key={one.key} className="wb-cmp__chip" data-kind="file" data-state={one.error !== undefined ? 'error' : one.view === undefined ? 'uploading' : 'ok'} title={one.error ?? (one.image ? (seesImages ? '事务官能直接看这张图' : '这个模型看不了图,会把路径给它') : '在电脑的收件文件夹里')}>
                  {one.preview !== undefined && <img src={one.preview} alt="" />}
                  <span className="wb-cmp__chip-name">{one.name}</span>
                  {one.view === undefined && one.error === undefined && <span className="wb-cmp__chip-state">传着</span>}
                  {one.error !== undefined && <span className="wb-cmp__chip-state">没传上</span>}
                  <button type="button" aria-label={`去掉 ${one.name}`} onClick={() => removeAttachment(one.key)}>×</button>
                </span>
              ))}
              {draft.refs.map(ref => (
                <span key={`${ref.kind}-${ref.id}`} className="wb-cmp__chip" data-kind="ref">
                  # {ref.title}
                  <button type="button" aria-label={`不引用 ${ref.title}`} onClick={() => setDraft(d => ({ ...d, refs: d.refs.filter(one => !(one.kind === ref.kind && one.id === ref.id)) }))}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={setRefInput}
            className="wb-cmp__input"
            aria-label={ariaLabel}
            placeholder={placeholder}
            rows={rows}
            value={text}
            onChange={event => onChangeText(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="wb-cmp__bar">
            {spec.plus && (
              <button type="button" className="wb-cmp__plus" aria-label="添加" aria-haspopup="menu" aria-expanded={menu === 'plus' || menu === 'refs'} onClick={() => openMenu('plus')}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            )}
            {spec.at && (
              <button
                type="button"
                className="wb-cmp__pill wb-cmp__pill--at"
                data-ready={draft.agent?.ready ?? true}
                aria-label="交给谁"
                aria-haspopup="menu"
                aria-expanded={menu === 'at'}
                onClick={() => { setAtState(undefined); openMenu('at') }}
              >
                @ {draft.agent?.title ?? '事务官'}
              </button>
            )}
            <span className="wb-cmp__spacer" />
            {note !== undefined && <span className="wb-cmp__note" role="status">{note}</span>}
            {spec.mode && (
              <button type="button" className="wb-cmp__pill" aria-label={`模式:${modeTitle(options, mode)}`} aria-haspopup="menu" aria-expanded={menu === 'mode'} onClick={() => openMenu('mode')}>
                {modeTitle(options, mode)} <Chevron />
              </button>
            )}
            {spec.model && model !== undefined && (
              <button type="button" className="wb-cmp__pill" aria-label={`模型:${model.id}`} aria-haspopup="menu" aria-expanded={menu === 'model'} onClick={() => openMenu('model')}>
                {model.title} <Chevron />
              </button>
            )}
            <button
              type="submit"
              className="wb-cmp__send"
              aria-label={sendLabel}
              title={!sendable && draft.agent?.ready === false ? (draft.agent.why ?? '未就绪') : (busy ? '在路上' : sendLabel)}
              disabled={!sendable}
              data-busy={busy}
            >
              {busy
                ? <span className="wb-cmp__dots" aria-hidden="true">···</span>
                : <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>}
            </button>
          </div>
          {dragging && <div className="wb-cmp__drop" aria-hidden="true">松手放进来</div>}
          {spec.plus && (
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => { addFiles(filesOf(event.target.files)); event.target.value = '' }}
            />
          )}
        </form>
      </FxBeam>
      {footer}
    </div>
  )
}
