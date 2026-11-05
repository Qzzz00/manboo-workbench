// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/VoiceBindingsForm.tsx
/**
 * 角色 × 场景级音色绑定编辑器（ALL-608 改造）。
 *
 * 一个「音色」= (provider, voice_id)。基准(chat)被聊天播报/语音气泡共用，并作为 DJ 口播/podcast
 * 的继承来源；RTC(rtc) 是另一种 provider 类型（火山 RTC 命名空间）。
 *
 * 顶部三种同步模式（契约 ALL-605，见 docs/voice-sync-contract.md）：
 *   - independent  分别配置：基准与 RTC 分别生效（旧行为），两侧均可编辑。
 *   - follow_base  以基准音色为准：基准为源，RTC 跟随 → RTC 侧只读，显示「跟随基准音色」。
 *   - follow_rtc   以通话音色为准：RTC 为源，基准跟随 → 基准侧只读，显示「跟随通话音色」。
 *
 * 保存走 PUT /api/voice-settings，服务端解析（统一模式查逻辑音色映射）并落地两套最终音色；
 * 保存成功后用服务端返回的最终配置刷新展示（与 GET /api/voice-settings/:avatarId 一致），
 * 不使用前端临时状态冒充成功。统一模式无映射时后端返回 VOICE_MAPPING_NOT_FOUND，前端原样展示错误。
 *
 * 2026-09-16（本仓库改动）：「分别配置」下基准与通话互不依赖——只选齐一侧时按场景
 * PUT /admin/avatars/:id/voice-bindings/{chat|rtc} 单独落地；两侧都齐才走 PUT /api/voice-settings
 * （顺带写 voice_sync_mode）。没配通话音色不报错、不阻塞基准保存。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/shared/components/toast';
import { AdminApiError } from '@/shared/api/errors';
import { getTtsVoices, refreshTtsVoices } from '@/features/settings/api/ttsProviders';
import { listTtsProviders } from '@/features/settings/api/ttsProviders';
import { listRtcProviders } from '@/features/settings/api/rtcProviders';
import { putVoiceBinding, deleteVoiceBinding } from '../api';
import {
  getVoiceSettings,
  listVoiceMappings,
  previewVoice,
  putVoiceSettings,
  type PutVoiceSettingsPayload,
} from '../api/voiceSettings';
import VoiceMappingManager from './VoiceMappingManager';
import type {
  LogicalVoiceMapping,
  RtcProvider,
  TtsProvider,
  TtsVoice,
  VoiceAvailability,
  VoiceBinding,
  VoiceRef,
  VoiceScene,
  VoiceSyncMode,
} from '@/shared/types';

interface ProviderOption {
  id: string;
  name: string;
  provider_type: string;
}

interface SlotConfig {
  scene: VoiceScene;
  kind: 'tts' | 'rtc';
  label: string;
  hint: string;
  inheritable: boolean; // 可继承基准(chat)
}

const SLOTS: SlotConfig[] = [
  { scene: 'chat', kind: 'tts', label: '基准音色（聊天播报 / 语音气泡）', hint: '角色的标准音色。DJ 口播 / podcast 不单独配置时继承它。', inheritable: false },
  { scene: 'rtc', kind: 'rtc', label: '通话音色（RTC）', hint: '实时通话用，必须是火山 RTC 音色；与基准 provider 不同时务必单独配置。', inheritable: false },
  { scene: 'dj_intro', kind: 'tts', label: 'DJ 口播音色', hint: '不开启则继承基准音色。', inheritable: true },
  { scene: 'dj_podcast', kind: 'tts', label: 'DJ Podcast 音色', hint: '不开启则继承基准音色（如需联合主播可单独配置）。', inheritable: true },
];

const MODE_OPTIONS: { value: VoiceSyncMode; label: string; hint: string }[] = [
  { value: 'independent', label: '分别配置', hint: '基准音色与通话音色分别生效（默认）。' },
  { value: 'follow_base', label: '以基准音色为准', hint: '通话音色跟随基准音色（经逻辑音色映射）。没有通话需求就选「分别配置」。' },
  { value: 'follow_rtc', label: '以通话音色为准', hint: '基准音色跟随通话音色（经逻辑音色映射）。没有通话需求就选「分别配置」。' },
];

/** 待保存状态快照：模式 + 两侧音色（服务端为权威，统一模式只按源侧提交）。 */
interface DesiredState {
  mode: VoiceSyncMode;
  base: VoiceRef | null;
  rtc: VoiceRef | null;
}

function makeDesired(mode: VoiceSyncMode, base: VoiceRef | null, rtc: VoiceRef | null): DesiredState {
  return { mode, base, rtc };
}

function trimRef(r: VoiceRef): VoiceRef {
  return { provider_id: r.provider_id, voice_id: r.voice_id.trim() };
}

/** 构造 PUT /api/voice-settings 请求体：统一模式只提交源侧，独立模式两侧都提交。 */
function buildPayload(avatarId: string, d: DesiredState): PutVoiceSettingsPayload {
  const p: PutVoiceSettingsPayload = { avatar_id: avatarId, voice_sync_mode: d.mode };
  if (d.mode === 'independent') {
    if (d.base) p.base_voice = trimRef(d.base);
    if (d.rtc) p.rtc_voice = trimRef(d.rtc);
  } else if (d.mode === 'follow_base') {
    if (d.base) p.base_voice = trimRef(d.base);
  } else {
    if (d.rtc) p.rtc_voice = trimRef(d.rtc);
  }
  return p;
}

function completeRef(r: VoiceRef | null | undefined): r is VoiceRef {
  return !!(r?.provider_id && r.voice_id.trim());
}

/** 服务端已落地的快照（我们所知的最新值）；独立模式按侧更新。 */
type SavedState = DesiredState;
type SavedScene = 'base' | 'rtc';
const SCENE_LABEL: Record<SavedScene, string> = { base: '基准', rtc: '通话' };

function sameRef(a: VoiceRef | undefined, b: VoiceRef | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (!a || !b) return false;
  return a.provider_id === b.provider_id && a.voice_id === b.voice_id;
}

function payloadsEqual(a: PutVoiceSettingsPayload, b: PutVoiceSettingsPayload): boolean {
  return a.voice_sync_mode === b.voice_sync_mode
    && sameRef(a.base_voice, b.base_voice)
    && sameRef(a.rtc_voice, b.rtc_voice);
}

function fmtError(err: unknown, fallback: string): string {
  if (err instanceof AdminApiError) {
    return err.code ? `${err.message}（${err.code}）` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

function VoiceSlot({
  avatarId,
  config,
  providers,
  binding,
  refValue,
  onRefChange,
  follow,
}: {
  avatarId: string;
  config: SlotConfig;
  providers: ProviderOption[];
  binding?: VoiceBinding;
  /** 受控当前值（仅 chat/rtc 同步槽位传入）；缺省时走内部非受控状态（DJ 槽位）。 */
  refValue?: VoiceRef | null;
  onRefChange?: (ref: VoiceRef) => void;
  /** 统一模式下被跟随侧只读，显示跟随文案 + 服务端最终音色。 */
  follow?: { label: string; voice: VoiceRef | null } | null;
}) {
  const controlled = refValue !== undefined && onRefChange !== undefined;
  const [enabled, setEnabled] = useState(config.inheritable ? Boolean(binding) : true);
  const [internalProviderId, setInternalProviderId] = useState(
    binding?.provider_id ?? (config.kind === 'tts' ? providers[0]?.id ?? '' : providers[0]?.id ?? ''),
  );
  const [internalVoiceId, setInternalVoiceId] = useState(binding?.voice_id ?? '');
  const [official, setOfficial] = useState<TtsVoice[]>([]);
  const [cloned, setCloned] = useState<TtsVoice[]>([]);
  // 这一单是什么时候向火山取回来的(2026-09-27,卡 VO)。取不到时 note 里写着实话,页面**原样显示**。
  const [availability, setAvailability] = useState<VoiceAvailability | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  /** 重取一趟要两三分钟,这个数一变就重新拉一次清单。 */
  const [voicesEpoch, setVoicesEpoch] = useState(0);
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewLock = useRef(false);

  const providerId = controlled ? (refValue?.provider_id ?? '') : internalProviderId;
  const voiceId = controlled ? (refValue?.voice_id ?? '') : internalVoiceId;

  function commit(nextProviderId: string, nextVoiceId: string) {
    if (controlled) onRefChange({ provider_id: nextProviderId, voice_id: nextVoiceId });
    else { setInternalProviderId(nextProviderId); setInternalVoiceId(nextVoiceId); }
  }

  // 选中 provider 变化 → 拉该 provider 的音色清单。
  useEffect(() => {
    if (!enabled || !providerId) {
      setOfficial([]);
      setCloned([]);
      setAvailability(undefined);
      return;
    }
    let alive = true;
    getTtsVoices({ providerId, kind: config.kind })
      .then((v) => {
        if (!alive) return;
        setOfficial(v.official);
        setCloned(v.cloned);
        setAvailability(v.availability);
      })
      .catch(() => {
        if (alive) { setOfficial([]); setCloned([]); setAvailability(undefined); }
      });
    return () => { alive = false; };
  }, [enabled, providerId, config.kind, voicesEpoch]);

  /** 「重新取一遍」:维护者刚在火山控制台开通/退订了一档,不想等它自己过期。 */
  async function onRefreshVoices() {
    setRefreshing(true);
    try {
      const res = await refreshTtsVoices();
      toast.success(res.note);
      // 起了就回,后台还在跑。过一会儿再拉一次清单,看 availability 变了没有。
      window.setTimeout(() => setVoicesEpoch((n) => n + 1), 5000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重取音色清单失败');
    } finally {
      setRefreshing(false);
    }
  }

  const known = [...official, ...cloned].some((v) => v.id === voiceId);
  const useCustomInput = custom || (voiceId !== '' && !known && official.length + cloned.length > 0) || official.length + cloned.length === 0;

  async function onSave() {
    if (!providerId) { toast.error('请先选择 provider'); return; }
    if (!voiceId.trim()) { toast.error('请选择或填写音色'); return; }
    setSaving(true);
    try {
      await putVoiceBinding(avatarId, config.scene, { providerId, voiceId: voiceId.trim() });
      toast.success('音色绑定已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function onClear() {
    setSaving(true);
    try {
      await deleteVoiceBinding(avatarId, config.scene);
      setEnabled(false);
      if (controlled) onRefChange({ provider_id: '', voice_id: '' });
      else { setInternalProviderId(''); setInternalVoiceId(''); }
      toast.success(config.inheritable ? '已恢复继承基准' : '已清除绑定');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清除失败');
    } finally {
      setSaving(false);
    }
  }

  async function onPreview() {
    // 防重复点击：state 更新前的快速连点由 ref 兜底。
    if (previewLock.current) return;
    if (!providerId) { toast.error('请先选择 provider'); return; }
    if (!voiceId.trim()) { toast.error('请先选择或填写音色'); return; }
    previewLock.current = true;
    setPreviewing(true);
    try {
      const res = await previewVoice({
        provider_id: providerId,
        voice_id: voiceId.trim(),
        scene: config.kind === 'rtc' ? 'rtc' : 'base',
      });
      if (!res.audio_url || typeof res.audio_url !== 'string') {
        toast.error('试听失败：接口未返回可用的音频地址');
        return;
      }
      const audio = new Audio(res.audio_url);
      await audio.play();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '试听失败');
    } finally {
      previewLock.current = false;
      setPreviewing(false);
    }
  }

  // 统一模式被跟随侧：只读展示，不提供编辑/试听。
  if (follow) {
    const voiceName = follow.voice
      ? `${providers.find((p) => p.id === follow.voice?.provider_id)?.name ?? follow.voice.provider_id} / ${follow.voice.voice_id}`
      : '（未配置）';
    return (
      <div style={{ borderTop: '1px solid var(--border, #eee)', paddingTop: 12, marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <strong>{config.label}</strong>
        </div>
        <p className="hint" style={{ marginTop: 2 }}>{config.hint}</p>
        <div className="readonly-banner" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="readonly-banner-icon">🔒</span>
          <span className="readonly-banner-text">
            {follow.label} · {voiceName}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ borderTop: '1px solid var(--border, #eee)', paddingTop: 12, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <strong>{config.label}</strong>
        {config.inheritable && (
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => { setEnabled(e.target.checked); if (!e.target.checked) void onClear(); }}
            />
            单独配置
          </label>
        )}
      </div>
      <p className="hint" style={{ marginTop: 2 }}>{config.hint}</p>

      {enabled && (
        <>
          <div className="grid-2 voice-slot-grid">
            <div>
              <label>Provider</label>
              <select
                value={providerId}
                onChange={(e) => { commit(e.target.value, ''); setCustom(false); }}
              >
                <option value="">（请选择）</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}（{p.provider_type}）</option>
                ))}
              </select>
            </div>

            <div>
              <label>音色</label>
              {useCustomInput ? (
                <>
                  <input
                    value={voiceId}
                    onChange={(e) => commit(providerId, e.target.value)}
                    placeholder="手填 voice_type / speaker_id"
                  />
                  {official.length + cloned.length > 0 && (
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => { setCustom(false); if (!known) commit(providerId, ''); }}>
                      ← 从列表选择
                    </button>
                  )}
                </>
              ) : (
                <select
                  value={voiceId}
                  onChange={(e) => { if (e.target.value === '__custom__') { setCustom(true); commit(providerId, ''); } else commit(providerId, e.target.value); }}
                >
                  <option value="">（请选择）</option>
                  {official.length > 0 && (
                    <optgroup label="官方音色">
                      {official.map((v) => <option key={`o-${v.id}`} value={v.id}>{v.name}（{v.id}）</option>)}
                    </optgroup>
                  )}
                  {cloned.length > 0 && (
                    <optgroup label="复刻音色">
                      {cloned.map((v) => <option key={`c-${v.id}`} value={v.id}>{v.name}（{v.id}）</option>)}
                    </optgroup>
                  )}
                  <option value="__custom__">自定义…</option>
                </select>
              )}
              {/* 这一单是几点、怎么取回来的 —— 取不到时这里明说「这次没取到」,不假装它是实取的。 */}
              {availability !== undefined && (
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span>{availability.note}</span>
                  <button type="button" className="btn btn-sm" disabled={refreshing} onClick={() => void onRefreshVoices()}>
                    {refreshing ? '正在取…' : '重新取一遍'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {!controlled && (
              <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void onSave()}>
                {saving ? '保存中…' : '保存'}
              </button>
            )}
            <button type="button" className="btn btn-sm" disabled={previewing || !providerId || !voiceId} onClick={() => void onPreview()}>
              {previewing ? '试听中…' : '🔊 试听'}
            </button>
            {!controlled && !config.inheritable && binding && (
              <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void onClear()}>
                清除
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function VoiceBindingsForm({
  avatarId,
  initialBindings,
}: {
  avatarId: string;
  initialBindings: VoiceBinding[];
}) {
  const [ttsProviders, setTtsProviders] = useState<TtsProvider[]>([]);
  const [rtcProviders, setRtcProviders] = useState<RtcProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncLoading, setSyncLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [mode, setMode] = useState<VoiceSyncMode>('independent');
  const [baseRef, setBaseRef] = useState<VoiceRef | null>(null);
  const [rtcRef, setRtcRef] = useState<VoiceRef | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 最近一次自动保存落地的场景（独立模式可能只有一侧）。 */
  const [savedScenes, setSavedScenes] = useState<SavedScene[]>([]);
  /** savedRef 的可渲染镜像（提示文案用）。 */
  const [savedView, setSavedView] = useState<SavedState | null>(null);
  const [mappings, setMappings] = useState<LogicalVoiceMapping[]>([]);
  const latestRef = useRef<DesiredState | null>(null);
  const savedRef = useRef<SavedState | null>(null);
  const runningRef = useRef(false);

  function commitSaved(next: SavedState) {
    savedRef.current = next;
    setSavedView(next);
  }

  const byScene = new Map(initialBindings.map((b) => [b.scene, b]));
  const chatBinding = byScene.get('chat');
  const rtcBinding = byScene.get('rtc');

  useEffect(() => {
    let alive = true;
    Promise.all([listTtsProviders(), listRtcProviders().catch(() => [])])
      .then(([tts, rtc]) => {
        if (!alive) return;
        setTtsProviders(tts);
        setRtcProviders(rtc);
      })
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, []);

  // 以服务端返回的最终配置（含同步模式）为权威来源初始化；接口不可用时回退到角色绑定的 chat/rtc。
  useEffect(() => {
    let alive = true;
    setSyncLoading(true);
    setSyncError(null);
    getVoiceSettings(avatarId)
      .then((s) => {
        if (!alive) return;
        setMode(s.voice_sync_mode);
        setBaseRef(s.base_voice);
        setRtcRef(s.rtc_voice);
        // 初始化不触发 PUT：把服务端返回的最终配置记为「已保存」基准。
        commitSaved(makeDesired(s.voice_sync_mode, s.base_voice, s.rtc_voice));
      })
      .catch((err) => {
        if (!alive) return;
        setSyncError(err instanceof Error ? err.message : '音色同步配置加载失败');
        const base = chatBinding ? { provider_id: chatBinding.provider_id, voice_id: chatBinding.voice_id } : null;
        const rtc = rtcBinding ? { provider_id: rtcBinding.provider_id, voice_id: rtcBinding.voice_id } : null;
        setBaseRef(base);
        setRtcRef(rtc);
        commitSaved(makeDesired('independent', base, rtc));
      })
      .finally(() => alive && setSyncLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarId]);

  // 拉取全部逻辑音色映射，供统一模式下的「可用映射状态」提示与保存前引导。
  useEffect(() => {
    let alive = true;
    listVoiceMappings()
      .then((m) => { if (alive) setMappings(m); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const followBase = mode === 'follow_rtc';
  const followRtc = mode === 'follow_base';

  // 统一模式下当前源音色是否已有启用映射（follow_base 以基准侧为源，follow_rtc 以 RTC 侧为源）。
  const sourceRef = mode === 'follow_base' ? baseRef : mode === 'follow_rtc' ? rtcRef : null;
  const availableMapping = useMemo(() => {
    if (mode !== 'follow_base' && mode !== 'follow_rtc') return undefined;
    if (!sourceRef?.provider_id || !sourceRef?.voice_id.trim()) return undefined;
    const pid = sourceRef.provider_id;
    const vid = sourceRef.voice_id.trim();
    if (mode === 'follow_base') {
      return mappings.find((m) => m.enabled && m.base_voice.provider_id === pid && m.base_voice.voice_id === vid);
    }
    return mappings.find((m) => m.enabled && m.rtc_voice.provider_id === pid && m.rtc_voice.voice_id === vid);
  }, [mode, sourceRef, mappings]);

  function currentDesired(): DesiredState {
    return makeDesired(mode, baseRef, rtcRef);
  }

  // 自动保存队列：latestRef 始终存「最新待保存状态」，循环串行提交，只保留最终状态；
  // 旧响应绝不覆盖新状态（仅在无更新的待保存时，才把服务端解析结果写回 UI）。
  function scheduleSave() {
    if (syncLoading) return;
    latestRef.current = currentDesired();
    if (runningRef.current) return;
    void runSaveLoop();
  }

  function failSave(err: unknown) {
    if (latestRef.current !== null) return; // 已有更新的待保存状态，错误由下一轮决定
    const msg = fmtError(err, '保存失败');
    setSaveError(msg);
    setSaveStatus('error');
    toast.error(msg);
  }

  /** 两侧一起提交 PUT /api/voice-settings（统一模式必经；独立模式两侧都齐时也走这里以便落 voice_sync_mode）。 */
  async function saveViaSettings(desired: DesiredState, scenes: SavedScene[]) {
    setSaveStatus('saving');
    try {
      const next = await putVoiceSettings(buildPayload(avatarId, desired));
      commitSaved(makeDesired(next.voice_sync_mode, next.base_voice, next.rtc_voice));
      if (latestRef.current === null) {
        // 没有更新的待保存状态，才用服务端返回的最终配置刷新（统一模式落地派生侧）。
        setMode(next.voice_sync_mode);
        setBaseRef(next.base_voice);
        setRtcRef(next.rtc_voice);
        setSavedScenes(scenes);
        setSaveStatus('saved');
      }
    } catch (err) {
      failSave(err);
    }
  }

  /** 统一模式：源侧齐 + 有启用映射才提交。 */
  async function saveUnified(desired: DesiredState, saved: SavedState | null) {
    const sourceOk = desired.mode === 'follow_base' ? completeRef(desired.base) : completeRef(desired.rtc);
    if (!sourceOk) { setSaveStatus('idle'); return; }
    if (saved && payloadsEqual(buildPayload(avatarId, desired), buildPayload(avatarId, saved))) return;
    if (availableMapping === undefined) {
      // 统一模式无启用映射：保留既有状态、不静默改模式，引导先行（横幅已给出提示）。
      setSaveStatus('idle');
      return;
    }
    await saveViaSettings(desired, ['base', 'rtc']);
  }

  /** 分别配置：基准与通话互不依赖，哪一侧选齐且有变化就单独落哪一侧。 */
  async function saveIndependent(desired: DesiredState, saved: SavedState | null) {
    const base = completeRef(desired.base) ? trimRef(desired.base) : null;
    const rtc = completeRef(desired.rtc) ? trimRef(desired.rtc) : null;
    const baseChanged = !!base && !sameRef(base, saved?.base ?? undefined);
    const rtcChanged = !!rtc && !sameRef(rtc, saved?.rtc ?? undefined);
    const modeChanged = saved?.mode !== 'independent';

    if (base && rtc) {
      // 两侧都齐：一次提交，顺带把 voice_sync_mode 写成 independent。
      if (!baseChanged && !rtcChanged && !modeChanged) return;
      const scenes: SavedScene[] = [];
      if (baseChanged || modeChanged) scenes.push('base');
      if (rtcChanged || modeChanged) scenes.push('rtc');
      await saveViaSettings(desired, scenes);
      return;
    }

    const jobs: SavedScene[] = [];
    if (baseChanged) jobs.push('base');
    if (rtcChanged) jobs.push('rtc');
    if (jobs.length === 0) {
      if (!base && !rtc) setSaveStatus('idle');
      return;
    }
    setSaveStatus('saving');
    try {
      for (const scene of jobs) {
        const ref = scene === 'base' ? base! : rtc!;
        await putVoiceBinding(avatarId, scene === 'base' ? 'chat' : 'rtc', { providerId: ref.provider_id, voiceId: ref.voice_id });
        const prev = savedRef.current;
        commitSaved(makeDesired(
          'independent',
          scene === 'base' ? ref : prev?.base ?? null,
          scene === 'rtc' ? ref : prev?.rtc ?? null,
        ));
      }
      if (latestRef.current === null) {
        setSavedScenes(jobs);
        setSaveStatus('saved');
      }
    } catch (err) {
      failSave(err);
    }
  }

  async function runSaveLoop() {
    runningRef.current = true;
    try {
      for (;;) {
        const desired = latestRef.current;
        latestRef.current = null;
        if (!desired) break;
        if (desired.mode === 'independent') await saveIndependent(desired, savedRef.current);
        else await saveUnified(desired, savedRef.current);
      }
    } finally {
      runningRef.current = false;
    }
  }

  // 模式 / 基准音色 / RTC 音色任一变化 → 自动保存；初始化加载不触发（syncLoading 期间跳过）。
  useEffect(() => {
    if (syncLoading) return;
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, baseRef, rtcRef, syncLoading, availableMapping]);

  if (!loaded || syncLoading) return <p className="hint">加载音色配置…</p>;

  const ttsOpts: ProviderOption[] = ttsProviders.map((p) => ({ id: p.id, name: p.name, provider_type: p.provider_type }));
  const rtcOpts: ProviderOption[] = rtcProviders.map((p) => ({ id: p.id, name: p.name, provider_type: p.provider_type }));

  return (
    <div>
      <label>音色（按场景）</label>
      <p className="hint" style={{ marginTop: 2 }} data-testid="voice-autosave-note">
        本区改动自动保存，不经过左侧「保存修改 / 无修改」按钮（那个只管形象与人设表单）。
      </p>
      <p className="hint" style={{ marginTop: 2 }}>
        音色 = provider + 音色 id。基准供聊天播报/语音气泡共用；通话与 DJ 可按需单独配置，互不串扰。
      </p>

      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
        {MODE_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 14, minWidth: 0 }}
          >
            <input
              type="radio"
              name={`voice-sync-mode-${avatarId}`}
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <span style={{ minWidth: 0 }}>
              <strong>{opt.label}</strong>
              <span className="hint" style={{ display: 'block', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {(mode === 'follow_base' || mode === 'follow_rtc') && (
        <div
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderRadius: 8,
            background: availableMapping ? 'var(--green-100, #e6f7e6)' : 'var(--yellow-100, #fff7e6)',
            fontSize: 13,
          }}
        >
          {availableMapping ? (
            <span>
              已找到逻辑音色映射（已启用）：基准 {availableMapping.base_voice.voice_id} → RTC {availableMapping.rtc_voice.voice_id}
            </span>
          ) : (
            <span>
              当前源音色暂无可用映射，统一模式将无法保存。请先在下方「逻辑音色映射」建立并启用对应配对；没有通话需求就选「分别配置」。
            </span>
          )}
        </div>
      )}

      {syncError && <p className="error-text" style={{ marginTop: 8 }}>同步配置读取失败，已回退角色绑定：{syncError}</p>}

      <VoiceSlot
        avatarId={avatarId}
        config={SLOTS[0]}
        providers={ttsOpts}
        binding={chatBinding}
        refValue={baseRef}
        onRefChange={setBaseRef}
        follow={followBase ? { label: '跟随通话音色', voice: baseRef } : null}
      />
      <VoiceSlot
        avatarId={avatarId}
        config={SLOTS[1]}
        providers={rtcOpts}
        binding={rtcBinding}
        refValue={rtcRef}
        onRefChange={setRtcRef}
        follow={followRtc ? { label: '跟随基准音色', voice: rtcRef } : null}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }} data-testid="voice-save-status">
        {saveStatus === 'saving' && <span className="hint" style={{ color: 'var(--muted)' }}>正在保存…</span>}
        {saveStatus === 'saved' && (mode === 'independent' && savedScenes.length > 0 ? savedScenes : (['base', 'rtc'] as SavedScene[])).map((sc) => (
          <span key={sc} className="hint" style={{ color: 'var(--green-700, #1a7f37)' }}>已自动保存 · {SCENE_LABEL[sc]}</span>
        ))}
        {saveStatus === 'error' && <span className="error-text">保存失败：{saveError}</span>}
        {saveStatus !== 'saving' && saveStatus !== 'error' && mode === 'independent' && !completeRef(rtcRef) && (
          completeRef(baseRef) && sameRef(trimRef(baseRef), savedView?.base ?? undefined)
            ? <span className="hint">{saveStatus === 'saved' ? '通话音色可选，需要打电话时再配。' : '基准音色已保存；通话音色可选，需要打电话时再配。'}</span>
            : !completeRef(baseRef) && <span className="hint">选齐基准音色（provider + 音色）即自动保存；通话音色可选，需要打电话时再配。</span>
        )}
      </div>

      <VoiceMappingManager mappings={mappings} onMappingsChange={setMappings} />

      <div style={{ borderTop: '1px solid var(--border, #eee)', marginTop: 12, paddingTop: 6 }}>
        <p className="hint">
          以下为 DJ 独立音色：不开启则继承上面的基准音色，不受同步模式影响。
        </p>
        {SLOTS.slice(2).map((slot) => (
          <VoiceSlot
            key={slot.scene}
            avatarId={avatarId}
            config={slot}
            providers={ttsOpts}
            binding={byScene.get(slot.scene)}
          />
        ))}
      </div>
    </div>
  );
}
