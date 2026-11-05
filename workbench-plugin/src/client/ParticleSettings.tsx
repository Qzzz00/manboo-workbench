import { useId, useState } from 'react'
import { TUNING_FIELDS, getBuiltinIcon, listBuiltinIcons } from './swarm/core.js'
import { getParticleSettingsStore, useParticleSettings, type ParticleSettingsStore } from './particleSettingsStore.ts'
import { describeQuality } from './particleScene.ts'

export function ParticleSettings({ store = getParticleSettingsStore(), onClose }: { store?: ParticleSettingsStore; onClose?: () => void }) {
  const idPrefix = useId()
  const state = useParticleSettings(store), [svg, setSvg] = useState(''), [query, setQuery] = useState(''), [limit, setLimit] = useState(24)
  const icons = listBuiltinIcons(query)
  const exportPreset = () => {
    const url = URL.createObjectURL(new Blob([store.exportText()], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'butler-swarm-v4.json'; link.click()
    queueMicrotask(() => URL.revokeObjectURL(url))
  }
  return <section className="ben-wb__particle-settings" aria-label="粒子设置">
    {onClose && <header className="ben-wb__particle-settings-head"><strong>粒子外观</strong><button type="button" onClick={onClose}>关闭外观设置</button></header>}
    <div className="ben-wb__particle-actions">
      <button type="button" onClick={() => store.setPaused(!state.paused)}>{state.paused ? '恢复动效' : '暂停动效'}</button>
      <button type="button" onClick={() => store.reset()}>恢复默认</button>
      <button type="button" onClick={exportPreset}>导出配置 JSON</button>
      <label>导入配置 JSON<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void store.importFile(file, 'json'); event.target.value = '' }} /></label>
    </div>
    <p>仅调整粒子外观与动效。文字输入不使用麦克风；动效预览不启动任务、语音或拨号。</p>
    <p className="ben-wb__particle-quality">当前画质:{describeQuality(state.preset.settings, state.quality.tier, state.quality.performanceMode)}
      {(state.quality.tier > 0 || state.quality.performanceMode) && <button type="button" onClick={() => store.restoreQuality()}>恢复完整画质</button>}
      <label><input type="checkbox" aria-label="性能模式" checked={state.quality.performanceMode} onChange={event => store.setPerformanceMode(event.target.checked)} />性能模式</label></p>
    <p><small>机器忙不过来时会自动少画一些(粒子减半、关柔光、光团减半),顺畅满 30 秒再一档一档加回来,直到回到你设的参数。等不及就按「恢复完整画质」,马上画全并重新评估。性能模式手动锁在最省的那一档。你的参数始终不会被改写。</small></p>
    {state.error && <p role="alert">{state.error}</p>}{state.message && <p role="status">{state.message}</p>}
    {[...new Set(TUNING_FIELDS.map(field => field.group))].map(group => <fieldset key={group}><legend>{group}</legend>
      {TUNING_FIELDS.filter(field => field.group === group).map(field => <div className="ben-wb__particle-field" key={field.key}>
        <label htmlFor={`${idPrefix}-particle-number-${field.key}`}>{field.label} <small>{field.unit}</small></label>
        <input aria-label={`${field.label}滑杆`} type="range" min={field.min} max={field.max} step={field.step} value={state.preset.settings[field.key]} onChange={event => store.setField(field.key, Number(event.target.value))} />
        <input id={`${idPrefix}-particle-number-${field.key}`} aria-label={`${field.label}数值`} type="number" min={field.min} max={field.max} step={field.step} value={state.preset.settings[field.key]} onChange={event => { if (event.target.value !== '') store.setField(field.key, Number(event.target.value)) }} />
      </div>)}
    </fieldset>)}
    <fieldset><legend>动效预览</legend><div className="ben-wb__particle-actions">
      <button type="button" onClick={() => store.preview({ mode: 'speaking', label: '说话动效预览' })}>说话动效预览</button>
      <button type="button" onClick={() => store.preview({ mode: 'calling', notice: 'confirmation', label: '黄色电话动效预览' })}>黄色电话动效预览</button>
      <button type="button" onClick={() => store.preview({ mode: 'calling', notice: 'failed', label: '红色电话动效预览' })}>红色电话动效预览</button>
      <button type="button" onClick={() => store.preview(undefined)}>关闭动效预览</button>
    </div></fieldset>
    <fieldset onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void store.importFile(file, 'svg') }}>
      <legend>SVG 导入</legend><p>拖拽、选择文件，或粘贴 SVG 源码（上限 256KB）。</p>
      <label>选择 SVG 文件<input type="file" accept=".svg,image/svg+xml" onChange={event => { const file = event.target.files?.[0]; if (file) void store.importFile(file, 'svg'); event.target.value = '' }} /></label>
      <label><input type="checkbox" checked={state.preset.fill} onChange={event => { void store.setFill(event.target.checked) }} />面状采样（关闭为轮廓）</label>
      <textarea aria-label="粘贴 SVG 源码" value={svg} onChange={event => setSvg(event.target.value)} />
      <button type="button" onClick={() => { void store.importText(async () => svg, 'svg') }}>导入粘贴的 SVG</button>
      {state.preset.svg && <button type="button" onClick={() => { void store.importText(async () => state.preset.svg, 'svg') }}>预览已保存 SVG</button>}
    </fieldset>
    <fieldset><legend>内置图标 · 120 个</legend>
      <input type="search" aria-label="搜索内置图标" placeholder="名称、用途或图标 ID" value={query} onChange={event => { setQuery(event.target.value); setLimit(24) }} />
      <div className="ben-wb__particle-icons">{icons.slice(0, limit).map(icon => <button key={icon.id} type="button" aria-label={`预览图标:${icon.label}`} onClick={() => { void store.selectIcon(icon.id) }}>
        <img alt="" loading="lazy" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(getBuiltinIcon(icon.id)!.svg)}`} /><span>{icon.label}</span>
      </button>)}</div>
      {icons.length === 0 && <p>没有匹配的图标。</p>}
      {icons.length > limit && <button type="button" onClick={() => setLimit(limit + 24)}>更多图标</button>}
    </fieldset>
  </section>
}
