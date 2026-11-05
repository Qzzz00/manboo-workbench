/**
 * 更换头像(2026-10-21 协作区评审 ⑤):内置头像 / 上传图片两页,裁剪缩放,预览,保存 / 取消 / 恢复默认。
 *
 * - 草稿只在这个弹层里;取消 = 什么都不动。「恢复默认」先进预览,点保存才生效。
 * - 上传:格式与大小在选文件时挡,太小 / 像素太多 / 坏图在解码后挡,就地说;拖动或方向键挪位置,滑杆缩放。
 * - 保存照片:浏览器里画成 256 方图 + 64 缩略图(PNG)交给本机存(`~/.dsh/workbench/` 下);原图不出这台电脑,
 *   跨机只带缩略图(座机服务登记名片时放进去)。
 */
import { useEffect, useRef, useState } from 'react'
import type { CollabAvatar } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import type { AvatarKind, Crop } from './avatarModel.ts'
import {
  AVATAR_PHOTO_PX, AVATAR_PRESETS, AVATAR_THUMB_PX, AVATAR_UPLOAD_TYPES, AVATAR_ZOOM_MAX, CROP_START,
  checkImageSize, checkUploadFile, clampCrop, cropSource, nudgeCrop,
} from './avatarModel.ts'
import { AvatarFace, PresetArt, avatarUrl, usePeople } from './people.tsx'

const PREVIEW_PX = 192
const KEY_STEP_PX = 8

type Draft = CollabAvatar | null

/** 把原图按裁剪画成 n×n 的 PNG。画不了(没有 canvas)回 undefined。 */
function render(img: HTMLImageElement, crop: Crop, n: number): string | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = n
  canvas.height = n
  const ctx = (() => { try { return canvas.getContext('2d') } catch { return null } })()
  if (ctx === null) return undefined
  const { sx, sy, side } = cropSource(img.naturalWidth, img.naturalHeight, crop)
  ctx.drawImage(img, sx, sy, side, side, 0, 0, n, n)
  return canvas.toDataURL('image/png')
}

export function AvatarEditor({ owner, name, kind, api, onClose, onReceipt }: {
  owner: string
  name: string
  kind: AvatarKind
  api: CollabApi
  onClose: () => void
  onReceipt: (text: string) => void
}) {
  const { avatars, baseUrl } = usePeople()
  const current = avatars[owner]
  const [draft, setDraft] = useState<Draft>(current ?? null)
  const [tab, setTab] = useState<'library' | 'upload'>(current?.kind === 'photo' ? 'upload' : 'library')
  const [img, setImg] = useState<HTMLImageElement | undefined>(undefined)
  const [crop, setCrop] = useState<Crop>(CROP_START)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const ticket = useRef(0)
  const drag = useRef<{ x: number, y: number } | undefined>(undefined)
  const [cropped, setCropped] = useState<string | undefined>(undefined)

  // 改过的照片再打开:把存着的那张读回来接着裁。
  useEffect(() => {
    if (current?.kind !== 'photo') return
    const mine = ++ticket.current
    const existing = new Image()
    existing.onload = () => { if (mine === ticket.current) setImg(existing) }
    existing.src = avatarUrl(baseUrl, owner, current)
  }, [current, baseUrl, owner])

  useEffect(() => {
    if (img === undefined) { setCropped(undefined); return }
    setCropped(render(img, crop, PREVIEW_PX))
  }, [img, crop])

  const load = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const mine = ++ticket.current
    const bad = checkUploadFile(file)
    if (bad !== undefined) { setError(bad); return }
    setError('正在读取图片…')
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('read'))
        reader.readAsDataURL(file)
      })
      const next = new Image()
      await new Promise<void>((resolve, reject) => { next.onload = () => resolve(); next.onerror = () => reject(new Error('decode')); next.src = src })
      if (mine !== ticket.current) return
      const tooBad = checkImageSize(next.naturalWidth, next.naturalHeight)
      if (tooBad !== undefined) { setError(tooBad); return }
      setError(undefined)
      setImg(next)
      setCrop(CROP_START)
      setDraft({ kind: 'photo', v: 0 })
    }
    catch {
      if (mine === ticket.current) setError('图片打不开,可能坏了,换一张试试。')
    }
  }

  const move = (dx: number, dy: number): void => {
    if (img === undefined) return
    setCrop(value => nudgeCrop(value, dx, dy, img.naturalWidth, img.naturalHeight, PREVIEW_PX))
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    let got
    if (draft === null) got = await api.post('/collab/avatar/reset', { owner })
    else if (draft.kind === 'preset') got = await api.post('/collab/avatar/save', { owner, preset: draft.id })
    else {
      const photo = img === undefined ? undefined : render(img, crop, AVATAR_PHOTO_PX)
      const thumb = img === undefined ? undefined : render(img, crop, AVATAR_THUMB_PX)
      if (photo === undefined || thumb === undefined) { setBusy(false); setError('这里画不了图,照片存不了;可以先用内置头像。'); return }
      got = await api.post('/collab/avatar/save', { owner, photo, thumb })
    }
    setBusy(false)
    if (!got.ok) { setError(got.error ?? '没存上'); return }
    onReceipt(draft === null ? '头像恢复默认了' : '头像换好了')
    onClose()
  }

  const previewPhoto = draft?.kind === 'photo' && cropped !== undefined ? cropped : undefined
  const presets = AVATAR_PRESETS.filter(one => one.kind === kind)
  return (
    <div className="ben-cl__dialog-veil" onClick={onClose}>
      <div className="ben-cl__dialog ben-cl__avatar-editor" role="dialog" aria-label={`更换头像 · ${name}`} onClick={event => event.stopPropagation()}>
        <header className="ben-cl__dlg-head">
          <h2>更换头像 · {name}</h2>
          <button type="button" className="ben-cl__icon" onClick={onClose} aria-label="关上">✕</button>
        </header>
        <div className="ben-cl__avatar-preview" aria-label="预览">
          <span className="ben-cl__avatar-large"><AvatarFace owner={owner} name={name} kind={kind} draft={draft} {...(previewPhoto === undefined ? {} : { photoSrc: previewPhoto })} /></span>
          <span>
            <b>{name}</b>
            <span className="ben-cl__muted">{kind === 'agent' ? 'Agent · 圆角头像' : '成员 · 圆形头像'}</span>
            <span className="ben-cl__person"><AvatarFace owner={owner} name={name} kind={kind} draft={draft} {...(previewPhoto === undefined ? {} : { photoSrc: previewPhoto })} />{name}</span>
          </span>
        </div>
        <div className="ben-cl__seg" role="tablist" aria-label="头像来源">
          <button type="button" role="tab" aria-selected={tab === 'library'} onClick={() => { ticket.current++; setTab('library') }}>内置头像</button>
          <button type="button" role="tab" aria-selected={tab === 'upload'} onClick={() => { ticket.current++; setTab('upload') }}>上传图片</button>
        </div>
        {tab === 'library'
          ? (
              <div className="ben-cl__avatar-grid" role="group" aria-label={kind === 'agent' ? '机器人头像' : '人物头像'}>
                {presets.map(one => (
                  <button
                    key={one.id}
                    type="button"
                    aria-label={one.label}
                    aria-pressed={draft?.kind === 'preset' && draft.id === one.id}
                    data-round={kind === 'human'}
                    onClick={() => { ticket.current++; setImg(undefined); setError(undefined); setDraft({ kind: 'preset', id: one.id }) }}
                  >
                    <PresetArt id={one.id} />
                  </button>
                ))}
              </div>
            )
          : (
              <div className="ben-cl__avatar-upload">
                <label className="ben-cl__secondary">
                  选一张图片
                  <input type="file" accept={AVATAR_UPLOAD_TYPES.join(',')} aria-label="选一张图片" onChange={event => void load(event.target.files?.[0])} />
                </label>
                {img !== undefined && (
                  <>
                    <div
                      className="ben-cl__crop"
                      role="img"
                      tabIndex={0}
                      aria-label="裁剪区:拖动或用方向键调位置"
                      style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
                      onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; (event.target as Element).setPointerCapture?.(event.pointerId) }}
                      onPointerMove={(event) => {
                        if (drag.current === undefined) return
                        move(event.clientX - drag.current.x, event.clientY - drag.current.y)
                        drag.current = { x: event.clientX, y: event.clientY }
                      }}
                      onPointerUp={() => { drag.current = undefined }}
                      onKeyDown={(event) => {
                        const step: Record<string, [number, number]> = { ArrowLeft: [KEY_STEP_PX, 0], ArrowRight: [-KEY_STEP_PX, 0], ArrowUp: [0, KEY_STEP_PX], ArrowDown: [0, -KEY_STEP_PX] }
                        const hit = step[event.key]
                        if (hit === undefined) return
                        event.preventDefault()
                        move(hit[0], hit[1])
                      }}
                    >
                      {cropped !== undefined && <img src={cropped} alt="" width={PREVIEW_PX} height={PREVIEW_PX} />}
                    </div>
                    <label>
                      缩放
                      <input type="range" min={1} max={AVATAR_ZOOM_MAX} step={0.05} value={crop.zoom} aria-label="缩放" onChange={event => setCrop(value => clampCrop({ ...value, zoom: Number(event.target.value) }))} />
                    </label>
                  </>
                )}
              </div>
            )}
        {error !== undefined && <p className="ben-cl__muted" role="alert">{error}</p>}
        <footer className="ben-cl__dlg-foot">
          <button type="button" onClick={() => { ticket.current++; setImg(undefined); setError(undefined); setDraft(null) }} disabled={draft === null}>恢复默认</button>
          <span className="ben-cl__spacer" />
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="ben-cl__primary"
            disabled={busy || (draft === null && current === undefined) || (draft?.kind === 'photo' && img === undefined)}
            onClick={() => void save()}
          >保存</button>
        </footer>
      </div>
    </div>
  )
}
