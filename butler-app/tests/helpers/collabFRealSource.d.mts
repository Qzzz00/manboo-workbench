import type { LanChannelMessage, LanChannelSourceScope } from '../../src/api/protocol';
interface Instance { port: number; url: string; dir: string; close(): Promise<void> }
export interface OriginalFMobileQa {
  root: string; project: string; sender: Instance; receiver: Instance; originUrl: string;
  initial: { sender: { messages: LanChannelMessage[]; source_scope: LanChannelSourceScope }; receiver: { messages: LanChannelMessage[]; source_scope: LanChannelSourceScope }; feed: { added: number } };
  stopOrigin(): Promise<void>;
  closeReceiver(): Promise<void>;
  restartReceiver(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}
export function startOriginalFMobileQa(options: { root: string; portA?: number; portB?: number }): Promise<OriginalFMobileQa>;
