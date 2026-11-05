/**
 * 手机上统一输入框的几条请求(2026-09-24)。**全走 8791**(手机不跑 DSH 前端),与电脑调的是同一组口:
 * GET /composer/options、POST /composer/choice、POST /composer/upload、POST /approvals/answer。
 *
 * 附件的两条路:
 * 1. 同一个局域网:直连 8791 传(`session.direct`,与会议录音同一个理由 —— 文件不经中转);
 * 2. 在外面(直连不通):走房间里「发文件」那条 LiveKit 字节流(`wb.file`),落进电脑的同一个收件文件夹。
 *    名字前面加一段随机码,免得跟收件夹里已有的同名文件撞上被改名(那样服务端就对不上 id 了)。
 */
import type { ComposerMode, ComposerOptionsView, ComposerUploadView } from '../api/protocol';
import type { Session } from '../session';
import { uploadName } from './composerModel';

export interface ComposerApi {
  loadOptions(): Promise<ComposerOptionsView | { error: string }>;
  saveChoice(choice: { mode?: ComposerMode; model?: { provider: string; id: string } }): Promise<boolean>;
  upload(file: File): Promise<{ ok: true; view: ComposerUploadView } | { ok: false; error: string }>;
}

export function sessionComposerApi(session: Session): ComposerApi {
  return {
    async loadOptions() {
      const r = await session.client.json<ComposerOptionsView>('/composer/options');
      if (!r.ok) return { error: r.status === 404 ? '电脑上的工作台还没有这些菜单(要升级一下)' : r.error };
      if (!Array.isArray(r.data?.agents)) return { error: '菜单没拉到' };
      return r.data;
    },
    async saveChoice(choice) {
      const r = await session.client.json('/composer/choice', { method: 'POST', body: choice });
      return r.ok;
    },
    async upload(file) {
      const name = uploadName(file);
      const direct = await session.direct.json<ComposerUploadView & { ok?: boolean }>(`/composer/upload?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      });
      if (direct.ok && typeof direct.data?.id === 'string') return { ok: true, view: direct.data };
      if (direct.ok || direct.kind !== 'network') return { ok: false, error: direct.ok ? '没传上' : direct.error };
      // 在外面:走房间的字节流。
      const relayName = `${Math.random().toString(36).slice(2, 6)}-${name}`;
      const renamed = new File([file], relayName, { type: file.type });
      // `purpose: attachment`(2026-09-25,卡 J):电脑首页据此不把它当成「手机发来了一个文件」—— 它挂在事项上。
      const sent = await session.channel.sendFile(renamed, undefined, { purpose: 'attachment' });
      if (!sent.ok) return { ok: false, error: `在外面传不上:${sent.error}` };
      return { ok: true, view: { id: relayName, name: relayName, type: file.type, bytes: file.size, image: file.type.startsWith('image/') } };
    },
  };
}

export async function answerApproval(session: Session, id: string, allow: boolean): Promise<string | undefined> {
  const r = await session.client.json('/approvals/answer', { method: 'POST', body: { id, allow } });
  return r.ok ? undefined : r.error;
}
