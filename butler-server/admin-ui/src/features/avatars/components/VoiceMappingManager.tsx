// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/VoiceMappingManager.tsx
/**
 * 逻辑音色映射管理（ALL-604 返工）。
 *
 * 统一模式（follow_base / follow_rtc）通过逻辑音色映射把「基准音色」和「RTC 音色」按同一
 * 逻辑配对；没有启用映射时服务端 fail-closed 拒绝保存（VOICE_MAPPING_NOT_FOUND）。
 * 本组件补齐后台映射管理闭环：查看已有映射、创建/编辑、启用/停用、删除，并明确展示
 * 「基准音色 → RTC 音色」的方向。映射是全局资源（跨角色），一个逻辑音色 id 唯一对应
 * 一对 (base provider+voice, rtc provider+voice)。
 *
 * 复用现有后端契约 docs/voice-sync-contract.md：
 *   GET    /api/voice-mappings             列映射
 *   PUT    /api/voice-mappings/:id         新增/更新（upsert）
 *   DELETE /api/voice-mappings/:id         删除
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from '@/shared/components/toast';
import { listTtsProviders, getTtsVoices } from '@/features/settings/api/ttsProviders';
import { listRtcProviders } from '@/features/settings/api/rtcProviders';
import { AdminApiError } from '@/shared/api/errors';
import { deleteVoiceMapping, listVoiceMappings, putVoiceMapping } from '../api/voiceSettings';
import type { LogicalVoiceMapping, RtcProvider, TtsProvider, TtsVoice } from '@/shared/types';

interface Props {
  mappings: LogicalVoiceMapping[];
  onMappingsChange: (next: LogicalVoiceMapping[]) => void;
}

interface FormState {
  logicalVoiceId: string;
  baseProviderId: string;
  baseVoiceId: string;
  rtcProviderId: string;
  rtcVoiceId: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  logicalVoiceId: '',
  baseProviderId: '',
  baseVoiceId: '',
  rtcProviderId: '',
  rtcVoiceId: '',
  enabled: true,
};

function providerName(providers: Array<{ id: string; name: string }>, id: string): string {
  return providers.find((p) => p.id === id)?.name ?? id;
}

function fmtMappingError(err: unknown, fallback: string): string {
  if (err instanceof AdminApiError) {
    return err.code ? `${err.message}（${err.code}）` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

interface VoiceIdSelectProps {
  providerId: string;
  kind: 'tts' | 'rtc';
  value: string;
  testId: string;
  placeholder: string;
  onChange: (voiceId: string) => void;
}

/**
 * 按 Provider 加载官方/复刻音色下拉，显示「名称（id）」，提交值仍是 voice_id；
 * 无列表或自定义时回退手填输入，与基准/RTC 槽位使用同一 getTtsVoices 通道。
 */
function VoiceIdSelect({ providerId, kind, value, testId, placeholder, onChange }: VoiceIdSelectProps) {
  const [voices, setVoices] = useState<{ official: TtsVoice[]; cloned: TtsVoice[] }>({ official: [], cloned: [] });
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    if (!providerId) {
      setVoices({ official: [], cloned: [] });
      return;
    }
    let alive = true;
    getTtsVoices({ providerId, kind })
      .then((v) => { if (alive) setVoices({ official: v.official, cloned: v.cloned }); })
      .catch(() => { if (alive) setVoices({ official: [], cloned: [] }); });
    return () => { alive = false; };
  }, [providerId, kind]);

  const all = [...voices.official, ...voices.cloned];
  const known = all.some((v) => v.id === value);
  const showInput = custom || (value !== '' && !known && all.length > 0) || all.length === 0;

  if (showInput) {
    return (
      <>
        <input
          type="text"
          data-testid={testId}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {all.length > 0 && (
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => { setCustom(false); onChange(''); }}>
            ← 从列表选择
          </button>
        )}
      </>
    );
  }

  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => {
        if (e.target.value === '__custom__') { setCustom(true); onChange(''); }
        else onChange(e.target.value);
      }}
    >
      <option value="">（请选择）</option>
      {voices.official.length > 0 && (
        <optgroup label="官方音色">
          {voices.official.map((v) => <option key={`o-${v.id}`} value={v.id}>{v.name}（{v.id}）</option>)}
        </optgroup>
      )}
      {voices.cloned.length > 0 && (
        <optgroup label="复刻音色">
          {voices.cloned.map((v) => <option key={`c-${v.id}`} value={v.id}>{v.name}（{v.id}）</option>)}
        </optgroup>
      )}
      <option value="__custom__">自定义…</option>
    </select>
  );
}

export default function VoiceMappingManager({ mappings, onMappingsChange }: Props) {
  const [ttsProviders, setTtsProviders] = useState<TtsProvider[]>([]);
  const [rtcProviders, setRtcProviders] = useState<RtcProvider[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([listTtsProviders(), listRtcProviders().catch(() => [])])
      .then(([tts, rtc]) => {
        if (!alive) return;
        setTtsProviders(tts);
        setRtcProviders(rtc);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const ttsOpts = useMemo(() => ttsProviders.map((p) => ({ id: p.id, name: p.name })), [ttsProviders]);
  const rtcOpts = useMemo(() => rtcProviders.map((p) => ({ id: p.id, name: p.name })), [rtcProviders]);

  async function refresh() {
    const next = await listVoiceMappings();
    onMappingsChange(next);
    return next;
  }

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(m: LogicalVoiceMapping) {
    setEditingId(m.logical_voice_id);
    setForm({
      logicalVoiceId: m.logical_voice_id,
      baseProviderId: m.base_voice.provider_id,
      baseVoiceId: m.base_voice.voice_id,
      rtcProviderId: m.rtc_voice.provider_id,
      rtcVoiceId: m.rtc_voice.voice_id,
      enabled: m.enabled,
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function save() {
    const logicalVoiceId = form.logicalVoiceId.trim();
    const baseProviderId = form.baseProviderId.trim();
    const baseVoiceId = form.baseVoiceId.trim();
    const rtcProviderId = form.rtcProviderId.trim();
    const rtcVoiceId = form.rtcVoiceId.trim();
    if (!logicalVoiceId) { toast.error('请填写逻辑音色 ID'); return; }
    if (!baseProviderId || !baseVoiceId) { toast.error('请填写基准音色（provider + voice_id）'); return; }
    if (!rtcProviderId || !rtcVoiceId) { toast.error('请填写通话音色（provider + voice_id）'); return; }

    setSaving(true);
    try {
      await putVoiceMapping(logicalVoiceId, {
        base_voice: { provider_id: baseProviderId, voice_id: baseVoiceId },
        rtc_voice: { provider_id: rtcProviderId, voice_id: rtcVoiceId },
        enabled: form.enabled,
      });
      await refresh();
      closeForm();
      toast.success('逻辑音色映射已保存');
    } catch (err) {
      // 失败保留表单（不 closeForm），展示可读 message + 稳定 code，不吞错。
      toast.error(fmtMappingError(err, '保存映射失败'));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(m: LogicalVoiceMapping) {
    try {
      await putVoiceMapping(m.logical_voice_id, {
        base_voice: m.base_voice,
        rtc_voice: m.rtc_voice,
        enabled: !m.enabled,
      });
      await refresh();
      toast.success(m.enabled ? '已停用映射' : '已启用映射');
    } catch (err) {
      toast.error(fmtMappingError(err, '切换映射状态失败'));
    }
  }

  async function remove(logicalVoiceId: string) {
    setSaving(true);
    try {
      await deleteVoiceMapping(logicalVoiceId);
      await refresh();
      if (editingId === logicalVoiceId) closeForm();
      toast.success('已删除映射');
    } catch (err) {
      toast.error(fmtMappingError(err, '删除映射失败'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border, #eee)', marginTop: 12, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <strong>逻辑音色映射（基准音色 → RTC 音色）</strong>
        <button type="button" className="btn btn-sm" onClick={openCreate}>
          + 新建映射
        </button>
      </div>
      <p className="hint" style={{ marginTop: 2 }}>
        统一模式（以基准/通话音色为准）依赖这里建立「基准音色 ↔ RTC 音色」的同一逻辑配对；没有
        启用映射时保存会被拒绝。映射为全局资源，跨角色共享。
      </p>

      {mappings.length === 0 && (
        <p className="hint" style={{ marginTop: 8 }}>暂无映射。点击「新建映射」建立第一对逻辑音色配对。</p>
      )}

      {mappings.map((m) => (
        <div
          key={m.logical_voice_id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}
        >
          <span
            className="mono"
            style={{ fontSize: 12, color: 'var(--muted)' }}
          >
            {m.logical_voice_id}
          </span>
          <span style={{ fontSize: 13, minWidth: 0 }} className="mono">
            {providerName(ttsOpts, m.base_voice.provider_id)}/{m.base_voice.voice_id}
          </span>
          <span style={{ color: 'var(--slate-400)' }}>→</span>
          <span style={{ fontSize: 13, minWidth: 0 }} className="mono">
            {providerName(rtcOpts, m.rtc_voice.provider_id)}/{m.rtc_voice.voice_id}
          </span>
          <span
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 999,
              background: m.enabled ? 'var(--green-100, #e6f7e6)' : 'var(--slate-100, #eee)',
              color: m.enabled ? 'var(--green-700, #1a7f37)' : 'var(--muted)',
            }}
          >
            {m.enabled ? '已启用' : '已停用'}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" onClick={() => openEdit(m)}>
            编辑
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void toggle(m)}>
            {m.enabled ? '停用' : '启用'}
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={saving} onClick={() => void remove(m.logical_voice_id)}>
            删除
          </button>
        </div>
      ))}

      {formOpen && (
        <div data-testid="voice-mapping-form" style={{ marginTop: 12, border: '1px solid var(--border, #eee)', borderRadius: 8, padding: 12 }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="grid-2 voice-slot-grid">
              <div>
                <label>逻辑音色 ID *</label>
                <input
                  type="text"
                  data-testid="voice-mapping-logical-id"
                  value={form.logicalVoiceId}
                  disabled={editingId !== null}
                  placeholder="如 lv-taocheng"
                  onChange={(e) => setForm((f) => ({ ...f, logicalVoiceId: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                  />
                  启用
                </label>
              </div>
            </div>
            <div className="grid-2 voice-slot-grid">
              <div>
                <label>基准音色 Provider *</label>
                <select
                  data-testid="voice-mapping-base-provider"
                  value={form.baseProviderId}
                  onChange={(e) => setForm((f) => ({ ...f, baseProviderId: e.target.value, baseVoiceId: '' }))}
                >
                  <option value="">（请选择）</option>
                  {ttsProviders.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}（{p.provider_type}）</option>
                  ))}
                </select>
              </div>
              <div>
                <label>基准音色 voice_id *</label>
                <VoiceIdSelect
                  providerId={form.baseProviderId}
                  kind="tts"
                  value={form.baseVoiceId}
                  testId="voice-mapping-base-voice"
                  placeholder="如 male-qn-jingying"
                  onChange={(voiceId) => setForm((f) => ({ ...f, baseVoiceId: voiceId }))}
                />
              </div>
            </div>
            <div className="grid-2 voice-slot-grid">
              <div>
                <label>通话音色 Provider *</label>
                <select
                  data-testid="voice-mapping-rtc-provider"
                  value={form.rtcProviderId}
                  onChange={(e) => setForm((f) => ({ ...f, rtcProviderId: e.target.value, rtcVoiceId: '' }))}
                >
                  <option value="">（请选择）</option>
                  {rtcProviders.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}（{p.provider_type}）</option>
                  ))}
                </select>
              </div>
              <div>
                <label>通话音色 voice_id *</label>
                <VoiceIdSelect
                  providerId={form.rtcProviderId}
                  kind="rtc"
                  value={form.rtcVoiceId}
                  testId="voice-mapping-rtc-voice"
                  placeholder="如 zh_male_taocheng_uranus_bigtts"
                  onChange={(voiceId) => setForm((f) => ({ ...f, rtcVoiceId: voiceId }))}
                />
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存映射'}
            </button>
            <button type="button" className="btn btn-sm" onClick={closeForm}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}