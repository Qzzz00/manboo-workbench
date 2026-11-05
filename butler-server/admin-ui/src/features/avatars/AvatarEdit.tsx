// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarEdit.tsx(精简:去 LLM 模型库/世界书/旅程/DJ/记忆重置/公开资料)
/**
 * 形象编辑:name / summary / persona / transform / motions(description) / 背景 / 头像 / 提示音 / 音色绑定。
 * 保存时只 PATCH 被修改的可写字段(与初始详情做 diff),不发未改字段。
 *
 * 布局:左栏 sticky(预览视口切换 + Live2D 预览 + 保存常驻 + 版本记录),
 * 右栏 3 组 tab(形象 / 人设 / 配置),一次只渲染当前组。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { getAvatar, patchAvatar, getAvatarPreviewUrl } from '@/features/avatars/api';
import VoiceBindingsForm from './components/VoiceBindingsForm';
import { AdminApiError } from '@/shared/api/errors';
import { PersonaForm } from '@/features/avatars/components/PersonaForm';
import { AppearanceSection } from '@/features/avatars/components/edit/AppearanceSection';
import { StatusBadge } from '@/shared/components/StatusBadge';
import { resolvePreviewModelUrl } from '@/features/avatars/components/previewModelUrl';
// Live2D 预览内部 import 整个 pixi + cubism(~700KB),按需 lazy 加载。
const Live2DPreview = lazy(() =>
  import('@/features/avatars/components/Live2DPreview').then((m) => ({ default: m.Live2DPreview })),
);
import { BackgroundField } from '@/features/avatars/components/BackgroundField';
import { PortraitField } from '@/features/avatars/components/PortraitField';
import { AudioField } from '@/features/avatars/components/AudioField';
import { formatBytes } from '@/features/avatars/zipValidation';
import { toast } from '@/shared/components/toast';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import type {
  AvatarAdminDetail,
  ContextTemplate,
  MotionMap,
  PatchAvatarPayload,
  Persona,
  Transform,
} from '@/shared/types';

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 预览视口:手机竖屏 / 方屏 / 圆屏。构图数学对任意比例通用。 */
const PREVIEW_VIEWPORTS = [
  { key: 'phone', label: '手机 9:16', aspect: '9 / 16', circle: false },
  { key: 'square', label: '方屏 1:1', aspect: '1 / 1', circle: false },
  { key: 'round', label: '圆屏 1:1', aspect: '1 / 1', circle: true },
] as const;
type PreviewViewport = (typeof PREVIEW_VIEWPORTS)[number];

/** 右栏 3 组 tab;默认落「形象」。 */
type EditSection = 'appearance' | 'persona' | 'config';
const SECTION_TABS: ReadonlyArray<readonly [EditSection, string]> = [
  ['appearance', '形象'],
  ['persona', '人设'],
  ['config', '配置'],
];

/** 角色上下文模板默认值(保留给 prompt_template 字段;本机版页面上不编辑它)。 */
export function createDefaultPromptTemplate(avatarId: string): ContextTemplate {
  const now = new Date().toISOString();
  return {
    id: `${avatarId}-prompt-template-v1`,
    name: '角色上下文模板',
    story_string: [
      '{{char}} 正在与 {{user}} 对话。',
      '<lorebook_before_char>',
      '{{description}}',
      '{{personality}}',
      '{{original}}',
      '{{scenario}}',
      '<chat_summary>',
      '<history>',
      '<post_history>',
      '<lorebook_after_char>',
    ].join('\n'),
    user_prefix: '',
    user_suffix: '',
    assistant_prefix: '',
    assistant_suffix: '',
    ugc_policy: {
      allow_system_prompt_override: false,
      allow_post_history_override: false,
      force_original_macro: true,
    },
    version: 1,
    created_at: now,
    updated_at: now,
  };
}

export function AvatarEdit({ id }: { id: string }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [original, setOriginal] = useState<AvatarAdminDetail | null>(null);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [persona, setPersona] = useState<Persona | null>(null);
  const [transform, setTransform] = useState<Transform | null>(null);
  const [motions, setMotions] = useState<MotionMap>({});
  const initialSection: EditSection =
    (SECTION_TABS.find(([key]) => key === searchParams.get('section'))?.[0] as EditSection) || 'appearance';
  const [section, setSection] = useState<EditSection>(initialSection);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaultBackground, setDefaultBackground] = useState('');
  const [portraitUrl, setPortraitUrl] = useState('');
  const [ringtoneUrl, setRingtoneUrl] = useState('');
  const [notifySoundUrl, setNotifySoundUrl] = useState('');
  const [openingEnabled, setOpeningEnabled] = useState(false);
  const [openingText, setOpeningText] = useState('');
  const [idleEnhanceEnabled, setIdleEnhanceEnabled] = useState(true);
  const [idleEnhanceInterval, setIdleEnhanceInterval] = useState(''); // 空串 = 用客户端默认区间
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState<PreviewViewport>(PREVIEW_VIEWPORTS[0]);

  // 预览模型 URL:上传的形象(有版本)走 butler-server 签名预览。
  useEffect(() => {
    if (!original) { setPreviewUrl(null); return; }
    const seed = resolvePreviewModelUrl(original.id);
    if (seed) { setPreviewUrl(seed); return; }
    if (!original.current_version || original.current_version < 1) { setPreviewUrl(null); return; }
    let cancelled = false;
    getAvatarPreviewUrl(original.id)
      .then(({ baseUrl, modelEntry, modelUrl }) => {
        // 优先用服务端逐段 encodeURIComponent 过的 modelUrl(中文 / 全角符号 / # 都已是 ASCII);
        // Live2DPreview 内部的编码是幂等的,不会双重编码。老服务端没有 modelUrl 时退回原名拼接。
        if (!cancelled) setPreviewUrl(modelUrl ?? `${baseUrl}/${modelEntry}`);
      })
      .catch(() => { if (!cancelled) setPreviewUrl(null); });
    return () => { cancelled = true; };
  }, [original]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getAvatar(id)
      .then((a) => {
        if (!alive) return;
        setOriginal(a);
        setName(a.name);
        setSummary(a.summary);
        setPersona(a.persona);
        setTransform(a.transform);
        setMotions(a.motions ?? {});
        setDefaultBackground(a.default_background ?? '');
        setPortraitUrl(a.portrait_url ?? '');
        setRingtoneUrl(a.ringtone_url ?? '');
        setNotifySoundUrl(a.notify_sound_url ?? '');
        setOpeningEnabled(a.opening_enabled ?? false);
        setOpeningText(a.opening_text ?? '');
        setIdleEnhanceEnabled(a.idle_enhance_enabled ?? true);
        setIdleEnhanceInterval(a.idle_enhance_interval_sec != null ? String(a.idle_enhance_interval_sec) : '');
      })
      .catch((e) => toast.error(e instanceof AdminApiError ? e.message : '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  /** 只收集被修改的可写字段 */
  const payload = useMemo<PatchAvatarPayload>(() => {
    if (!original || !persona || !transform) return {};
    const p: PatchAvatarPayload = {};
    if (name !== original.name) p.name = name;
    if (summary !== original.summary) p.summary = summary;
    if (!eq(persona, original.persona)) p.persona = persona;
    if (!eq(transform, original.transform)) p.transform = transform;
    if (!eq(motions, original.motions ?? {})) p.motions = motions;
    if (defaultBackground !== (original.default_background ?? '')) {
      p.default_background = defaultBackground || null;
    }
    if (portraitUrl !== (original.portrait_url ?? '')) p.portrait_url = portraitUrl || null;
    if (ringtoneUrl !== (original.ringtone_url ?? '')) p.ringtone_url = ringtoneUrl || null;
    if (notifySoundUrl !== (original.notify_sound_url ?? '')) {
      p.notify_sound_url = notifySoundUrl || null;
    }
    if (openingEnabled !== (original.opening_enabled ?? false)) p.opening_enabled = openingEnabled;
    if (openingText !== (original.opening_text ?? '')) p.opening_text = openingText || null;
    if (idleEnhanceEnabled !== (original.idle_enhance_enabled ?? true)) {
      p.idle_enhance_enabled = idleEnhanceEnabled;
    }
    // 间隔:空串 = null(回退客户端默认区间);否则发整数(服务端校验 3–60)
    const idleIntervalNext = idleEnhanceInterval.trim() === '' ? null : Number(idleEnhanceInterval);
    if (idleIntervalNext !== (original.idle_enhance_interval_sec ?? null)) {
      p.idle_enhance_interval_sec = idleIntervalNext;
    }
    return p;
  }, [original, name, summary, persona, transform, motions, defaultBackground, portraitUrl, ringtoneUrl, notifySoundUrl, openingEnabled, openingText, idleEnhanceEnabled, idleEnhanceInterval]);

  const dirty = Object.keys(payload).length > 0;

  const onSave = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const updated = await patchAvatar(id, payload);
      setOriginal(updated);
      toast.success('已保存');
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="loading">加载中…</p>;
  if (!original || !persona || !transform) return <p className="empty">形象不存在</p>;

  return (
    <div>
      <div className="actions" style={{ marginBottom: 16 }}>
        <button className="btn" onClick={() => navigate('/avatars')}>
          返回列表
        </button>
      </div>

      <div className="edit-header" style={{ marginBottom: 12 }}>
        <div>
          <h2>
            编辑形象:{original.name} <StatusBadge status={original.status} />
          </h2>
          <p className="subtitle mono">
            ID {original.id} · 当前版本 v{original.current_version} · model_entry {original.model_entry}
          </p>
        </div>
      </div>

      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <div className="edit-grid">
          <div className="edit-preview-col">
            {previewUrl ? (
              <>
                <div className="tabbar" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {PREVIEW_VIEWPORTS.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      className={`btn btn-sm ${viewport.key === v.key ? 'btn-primary' : ''}`}
                      onClick={() => setViewport(v)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <div
                  className="card edit-preview"
                  style={{
                    aspectRatio: viewport.aspect,
                    borderRadius: viewport.circle ? '50%' : undefined,
                  }}
                >
                  <Suspense fallback={<p className="loading" style={{ padding: 24 }}>预览加载中…</p>}>
                    <Live2DPreview
                      modelUrl={previewUrl}
                      backgroundUrl={defaultBackground.trim() || undefined}
                      resizeKey={viewport.key}
                      framing={{
                        scaleMultiplier: transform.scaleMultiplier,
                        verticalOffset: transform.verticalOffset,
                        modelTransform: transform.modelTransform,
                      }}
                    />
                  </Suspense>
                </div>
                {viewport.circle && (
                  <p className="hint" style={{ marginTop: 6, textAlign: 'center' }}>
                    圆形屏预览:四角内容会被物理屏幕裁掉
                  </p>
                )}
              </>
            ) : (
              <div className="card">
                <p className="hint" style={{ margin: 0 }}>
                  该形象暂无可预览的版本。
                </p>
              </div>
            )}

            {/* 保存常驻左栏,切到任何组都能一键保存 */}
            <div className="card">
              <button
                className="btn btn-primary"
                style={{ width: '100%' }}
                disabled={!dirty || saving}
                onClick={() => void onSave()}
              >
                {saving ? '保存中…' : dirty ? '保存修改' : '无修改'}
              </button>
              {dirty && (
                <p className="hint" style={{ margin: '8px 0 0' }}>
                  将提交字段:<span className="mono">{Object.keys(payload).join(', ')}</span>
                </p>
              )}
            </div>

            <div className="card edit-history">
              <div className="section-title" style={{ marginTop: 0 }}>
                版本记录
              </div>
              <ul className="version-list" style={{ margin: 0, paddingLeft: 18 }}>
                {original.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version} · {formatBytes(v.size_bytes)} · sha256 {v.checksum.slice(0, 12)}… ·{' '}
                    {new Date(v.uploaded_at * 1000).toLocaleString('zh-CN', { hour12: false })}
                  </li>
                ))}
              </ul>
              <p className="hint" style={{ marginTop: 8 }}>
                换模型请
                <Link to={`/avatars/${id}/upload`} style={{ marginLeft: 4, color: 'var(--primary)' }}>
                  上传新版本
                </Link>
                。
              </p>
            </div>
          </div>

          <div>
            <div className="tabbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {SECTION_TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`btn btn-sm ${section === key ? 'btn-primary' : ''}`}
                  onClick={() => setSection(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── 形象:Transform/动作 + 待机增强 + 背景 + 头像 ── */}
            {section === 'appearance' && (
              <div className="edit-cards">
                <div className="span-all">
                  <AppearanceSection
                    transform={transform}
                    setTransform={setTransform}
                    motions={motions}
                    setMotions={setMotions}
                  />
                </div>

                <div className="card">
                  <div className="section-title" style={{ marginTop: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>待机动作增强</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>启用</span>
                      <input
                        type="checkbox"
                        checked={idleEnhanceEnabled}
                        onChange={(e) => setIdleEnhanceEnabled(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                    </label>
                  </div>
                  <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: idleEnhanceEnabled ? 1 : 0.5 }}>
                    <span style={{ minWidth: 96 }}>触发间隔(秒)</span>
                    <input
                      type="number"
                      min={3}
                      max={60}
                      step={1}
                      value={idleEnhanceInterval}
                      disabled={!idleEnhanceEnabled}
                      placeholder="默认(6–14 随机)"
                      onChange={(e) => setIdleEnhanceInterval(e.target.value)}
                      style={{ width: 160 }}
                    />
                  </label>
                  <p className="hint" style={{ marginTop: 4 }}>
                    开启后,形象待机时除基础摆动外,会每隔一段时间随机做一个小动作。间隔留空用客户端默认;填 3–60 秒。
                  </p>
                </div>

                <div className="card">
                  <div className="section-title" style={{ marginTop: 0 }}>
                    背景与头像
                  </div>
                  <div className="field-2col">
                    <BackgroundField value={defaultBackground} onChange={setDefaultBackground} />
                    <PortraitField value={portraitUrl} onChange={setPortraitUrl} />
                  </div>
                </div>
              </div>
            )}

            {/* ── 人设:名称/简介 + Persona + 开场白 ── */}
            {section === 'persona' && (
              <div className="edit-cards">
                <div className="card">
                  <label>名称 *</label>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
                  <label>简介 summary *</label>
                  <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
                </div>

                <div className="card span-all">
                  <div className="section-title" style={{ marginTop: 0 }}>
                    人设 Persona
                  </div>
                  <PersonaForm value={persona} onChange={setPersona} />
                </div>

                <div className="card">
                  <div className="section-title" style={{ marginTop: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>开场白</span>
                    <label className="switch" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>启动</span>
                      <input
                        type="checkbox"
                        checked={openingEnabled}
                        onChange={(e) => setOpeningEnabled(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                    </label>
                  </div>
                  <textarea
                    rows={3}
                    value={openingText}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val.length <= 200) setOpeningText(val);
                    }}
                    placeholder="在这里写下事务官的开场白…"
                    disabled={!openingEnabled}
                    style={{ resize: 'vertical', minHeight: 60, opacity: openingEnabled ? 1 : 0.5 }}
                  />
                  <p className="hint" style={{ marginTop: 4, textAlign: 'right' }}>
                    字数:{openingText.length} / 200
                  </p>
                </div>
              </div>
            )}

            {/* ── 配置:音色绑定 + 提示音 ── */}
            {section === 'config' && (
              <div className="edit-cards">
                <div className="card span-all">
                  <div className="section-title" style={{ marginTop: 0 }}>
                    音色
                  </div>
                  <p className="hint" style={{ marginBottom: 12 }}>
                    供应商与密钥在「音色与供应商」页配;这里把某个供应商的某个音色绑到这个形象上。
                  </p>
                  <VoiceBindingsForm avatarId={id} initialBindings={original?.voice_bindings ?? []} />
                </div>

                <div className="card">
                  <div className="section-title" style={{ marginTop: 0 }}>
                    提示音
                  </div>
                  <div className="field-2col">
                    <AudioField label="来电铃声" value={ringtoneUrl} onChange={setRingtoneUrl} />
                    <AudioField label="消息提示音" value={notifySoundUrl} onChange={setNotifySoundUrl} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </fieldset>
    </div>
  );
}
