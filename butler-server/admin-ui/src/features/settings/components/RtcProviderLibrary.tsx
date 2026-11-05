// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/settings/components/RtcProviderLibrary.tsx
/**
 * 类型化「实时通话(RTC)」provider 库（目前只有 volcengine_rtc）。
 * 字段随类型变化；密钥脱敏（preview + 留空不改）。结构对齐 TtsProviderLibrary。
 *
 * 这里填的就是「和角色打电话」所需的火山 RTC API 凭据：
 *   appId/appKey   —— 进房 Token 签发（服务端用 appKey 签，前端只拿 Token）
 *   AK/SK          —— StartVoiceChat / StopVoiceChat OpenAPI
 *   asrAppId / ttsAppId / arkEndpointId —— 智能体的 ASR / TTS / 豆包(方舟) 大脑
 */
import { useEffect, useState } from 'react';
import {
  createRtcProvider,
  deleteRtcProvider,
  listRtcProviders,
  patchRtcProvider,
} from '@/features/settings/api/rtcProviders';
import type { RtcProvider } from '@/shared/types';
import { AdminApiError } from '@/shared/api/errors';
import { toast } from '@/shared/components/toast';

type FieldSpec = { key: string; label: string; secret: boolean; placeholder?: string };

// 与服务端 rtcProviderStore.TYPES.volcengine_rtc 对应。
const FIELDS: FieldSpec[] = [
  { key: 'appId', label: 'RTC App ID', secret: false, placeholder: 'console.volcengine.com/rtc/aigc/listRTC' },
  { key: 'appKey', label: 'RTC App Key（签 Token 用）', secret: true },
  { key: 'accessKeyId', label: '火山 AccessKeyId（AK）', secret: false, placeholder: 'IAM 密钥' },
  { key: 'secretAccessKey', label: '火山 SecretAccessKey（SK）', secret: true },
  { key: 'asrAppId', label: 'ASR App ID（语音识别）', secret: false },
  { key: 'asrAccessToken', label: 'ASR Access Token（大模型/豆包流式识别必填）', secret: true },
  { key: 'asrApiResourceId', label: 'ASR Resource ID（可选；小时版 volc.bigasr.sauc.duration，并发版 .concurrent）', secret: false, placeholder: 'volc.bigasr.sauc.duration' },
  { key: 'ttsAppId', label: 'TTS App ID（语音合成）', secret: false },
  { key: 'ttsCluster', label: 'TTS Cluster', secret: false, placeholder: 'volcano_tts' },
  { key: 'arkEndpointId', label: '方舟 LLM 接入点 EndpointId（豆包大脑）', secret: false, placeholder: 'ep-xxxxxxxx' },
  { key: 'visionEndpointId', label: '视觉接入点 EndpointId（豆包视觉·视频通话用；留空则不显示"开摄像头"）', secret: false, placeholder: 'ep-xxxxxxxx' },
];

function emptyConfig(): Record<string, string> {
  return Object.fromEntries(FIELDS.map((f) => [f.key, '']));
}

export function RtcProviderLibrary() {
  const [items, setItems] = useState<RtcProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 新增草稿
  const [draftName, setDraftName] = useState('');
  const [draftConfig, setDraftConfig] = useState<Record<string, string>>(emptyConfig());
  const [draftDefault, setDraftDefault] = useState(false);

  // 编辑缓冲：id -> { name, config }
  const [edits, setEdits] = useState<Record<string, { name: string; config: Record<string, string> }>>({});

  function load() {
    setLoading(true);
    listRtcProviders()
      .then(setItems)
      .catch((e) => toast.error(e instanceof AdminApiError ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      load();
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function onCreate() {
    if (!draftName.trim()) {
      toast.error('名称必填');
      return;
    }
    const config: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = (draftConfig[f.key] || '').trim();
      if (v) config[f.key] = v;
    }
    void run(
      () => createRtcProvider({ name: draftName.trim(), provider_type: 'volcengine_rtc', config, isDefault: draftDefault }),
      '已新增',
    ).then(() => {
      setDraftName('');
      setDraftConfig(emptyConfig());
      setDraftDefault(false);
    });
  }

  function editBuf(p: RtcProvider) {
    return edits[p.id] ?? { name: p.name, config: { ...p.config } };
  }
  function setEditName(p: RtcProvider, name: string) {
    setEdits((prev) => ({ ...prev, [p.id]: { ...editBuf(p), ...prev[p.id], name } }));
  }
  function setEditField(p: RtcProvider, key: string, value: string) {
    setEdits((prev) => {
      const cur = prev[p.id] ?? { name: p.name, config: { ...p.config } };
      return { ...prev, [p.id]: { ...cur, config: { ...cur.config, [key]: value } } };
    });
  }

  function onSave(p: RtcProvider) {
    const b = editBuf(p);
    const config: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = (b.config[f.key] ?? '').trim();
      if (f.secret) {
        if (v) config[f.key] = v; // 密钥留空 = 不改
      } else {
        config[f.key] = v;
      }
    }
    void run(() => patchRtcProvider(p.id, { name: b.name, config }), '已保存').then(() =>
      setEdits((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      }),
    );
  }

  function onDelete(p: RtcProvider) {
    if (!window.confirm(`删除 RTC provider「${p.name}」？`)) return;
    void run(() => deleteRtcProvider(p.id), '已删除');
  }
  function onSetDefault(p: RtcProvider) {
    void run(() => patchRtcProvider(p.id, { isDefault: true }), '已设为默认');
  }

  if (loading) return <p className="loading">加载中…</p>;

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        和角色打电话（火山引擎 RTC 实时对话式 AI）所需凭据。App 端只向本服务请求进房 Token，AppKey / AK / SK
        只保存在此处、绝不下发到客户端。音色按角色在角色编辑页配置。设为「默认」的 provider 即通话所用。
      </p>

      {/* 新增 */}
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          新增 RTC provider（火山引擎）
        </div>
        <label>名称 *</label>
        <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="如 火山-豆包通话" />
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label>{f.label}</label>
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              value={draftConfig[f.key] || ''}
              onChange={(e) => setDraftConfig((c) => ({ ...c, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
            />
          </div>
        ))}
        <label className="field-row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={draftDefault} onChange={(e) => setDraftDefault(e.target.checked)} style={{ width: 'auto' }} />
          <span>设为默认</span>
        </label>
        <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={onCreate}>
          新增
        </button>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <p className="empty">暂无，先新增一个并设为默认。</p>
      ) : (
        items.map((p) => {
          const b = editBuf(p);
          return (
            <div className="card" key={p.id}>
              <div className="section-title" style={{ marginTop: 0 }}>
                {p.name}{' '}
                <span className="mono" style={{ color: 'var(--muted)' }}>
                  · 火山引擎{p.is_default ? ' · 默认' : ''}
                </span>
              </div>
              <label>名称</label>
              <input value={b.name} onChange={(e) => setEditName(p, e.target.value)} />
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label>
                    {f.label}
                    {f.secret && p.secrets[f.key]?.preview && (
                      <span className="mono"> · {p.secrets[f.key].preview}</span>
                    )}
                  </label>
                  <input
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={b.config[f.key] ?? ''}
                    onChange={(e) => setEditField(p, f.key, e.target.value)}
                    placeholder={f.secret ? '留空则不修改' : f.placeholder}
                  />
                </div>
              ))}
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => onSave(p)}>
                  保存
                </button>
                {!p.is_default && (
                  <button className="btn" disabled={busy} onClick={() => onSetDefault(p)}>
                    设为默认
                  </button>
                )}
                <button className="btn btn-danger" disabled={busy} onClick={() => onDelete(p)}>
                  删除
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
