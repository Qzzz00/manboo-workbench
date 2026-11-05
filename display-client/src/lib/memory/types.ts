import type { ChatMessage } from '../llm.ts';

export type SummaryStatus = 'fresh' | 'dirty';

export interface ChatSummary {
  id: string;
  chat_id: string;
  from_message_id: string;
  to_message_id: string;
  bound_message_id: string;
  content: string;
  token_count: number;
  status: SummaryStatus;
  created_at: string;
  prev_summary_id?: string;
}

export interface ChatMetadata {
  summaries: ChatSummary[];
}

export interface Chat {
  id: string;
  messages: ChatMessage[];
  metadata: ChatMetadata;
  characterName?: string;
  userName?: string;
}
