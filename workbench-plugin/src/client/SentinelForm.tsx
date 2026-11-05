/**
 * 「哨兵」新增监视项的表单(2026-09-09,借鉴 dsh-sentinel 的设计)。
 *
 * 放在设置弹窗里(跟凭据同一处"配置类"落点),而**列表在事务官浮窗**那一栏——
 * 配置一次的东西不该常驻在视野里,"现在在盯什么"才该。
 *
 * 四类传感器写死在 SENSOR_KINDS 里,`command` 不在其中,所以下拉框里也不会有它:
 * 这不是界面上少画了一项,是那一类根本不存在(审计结论,见 protocol.ts)。
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { SensorKind } from '../protocol.ts'
import { SENSOR_KINDS } from '../protocol.ts'
import { addWatch, SENSOR_LABEL, SENSOR_TARGET_HINT } from './sentinel.ts'
import { SetActions, SetBtn, SetField, SetFields, SetLead, SetMsg, SetSection } from './settings/setKit.tsx'

export interface SentinelFormProps {
  baseUrl: string
  fetchImpl?: typeof fetch
}

/** 秒数输入框:空着＝用服务端的默认值,不在这里替它编一个。 */
function toSeconds(text: string): number | undefined {
  const value = Number(text.trim())
  return text.trim() === '' || !Number.isFinite(value) || value <= 0 ? undefined : Math.floor(value)
}

export function SentinelForm({ baseUrl, fetchImpl }: SentinelFormProps) {
  const [kind, setKind] = useState<SensorKind>('file')
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const [interval, setInterval] = useState('')
  const [cooldown, setCooldown] = useState('')
  const [maxFires, setMaxFires] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const ready = target.trim() !== '' && note.trim() !== ''

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setMessage(undefined)
    const result = await addWatch(baseUrl, {
      kind,
      target: target.trim(),
      note: note.trim(),
      ...(toSeconds(interval) === undefined ? {} : { interval_sec: toSeconds(interval)! }),
      ...(toSeconds(cooldown) === undefined ? {} : { cooldown_sec: toSeconds(cooldown)! }),
      ...(toSeconds(maxFires) === undefined ? {} : { max_fires: toSeconds(maxFires)! }),
      // datetime-local 给的是本机时区的无时区串;交给 Date 解释成本机时刻再送(服务端只认可解析的时间)。
      ...(expires.trim() === '' ? {} : { expires_at: new Date(expires).toISOString() }),
    }, fetchImpl)
    setBusy(false)
    if (!result.ok) {
      // 服务端那句原话,不换措辞、不谎称加上了。
      setMessage(result.error)
      return
    }
    setTarget('')
    setNote('')
    setMessage('已开始盯 — 在事务官浮窗的「在盯着的事」里看')
  }

  // 评审页 `section('sentinel', '哨兵', …)`:一句 + 两列表单(盯什么 / 目标 / 变了跟你说〔整行〕/ 检查间隔 / 提醒冷却 / 次数上限 / 到期时间)
  // + 右下描边「开始监视」。稿里间隔与冷却是下拉(5 / 15 分钟、30 分钟 / 1 小时);我们照旧填秒数(空着 = 服务端默认 60 / 600)。
  return (
    <SetSection id="ben-wb-sentinel-form" title="哨兵">
      <SetLead>变了就提醒你。已有监视项在事务官浮窗查看。</SetLead>
      <form onSubmit={submit}>
        <SetFields>
          <SetField label="盯什么">
            <select value={kind} onChange={event => setKind(event.target.value as SensorKind)}>
              {SENSOR_KINDS.map(item => (
                <option key={item} value={item}>{SENSOR_LABEL[item]}</option>
              ))}
            </select>
          </SetField>
          <SetField label="目标">
            <input placeholder={SENSOR_TARGET_HINT[kind]} value={target} onChange={event => setTarget(event.target.value)} />
          </SetField>
          <SetField label="变了跟你说" full>
            <input placeholder="希望收到什么提醒(触发时显示的就是这句)" value={note} onChange={event => setNote(event.target.value)} />
          </SetField>
          <SetField label="检查间隔(秒)">
            <input inputMode="numeric" placeholder="默认 60" value={interval} onChange={event => setInterval(event.target.value)} />
          </SetField>
          <SetField label="提醒冷却(秒)">
            <input inputMode="numeric" placeholder="默认 600" value={cooldown} onChange={event => setCooldown(event.target.value)} />
          </SetField>
          <SetField label="次数上限">
            <input inputMode="numeric" placeholder="空着 = 不限" value={maxFires} onChange={event => setMaxFires(event.target.value)} />
          </SetField>
          <SetField label="到期时间">
            <input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} />
          </SetField>
        </SetFields>
        <SetActions>
          <SetBtn kind="outline" type="submit" disabled={!ready || busy}>开始监视</SetBtn>
        </SetActions>
      </form>
      {message !== undefined && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}
