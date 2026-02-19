export interface TextPayload {
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  chunkIndex: number;
  totalChunks: number;
  groupId: string;
}

export interface VoicePayload {
  text: string;
  audioText: string;
  chunkIndex: number;
  totalChunks: number;
  groupId: string;
}

export interface PhotoPayload {
  filePath: string;
  caption?: string;
}

export type QueuePayload = TextPayload | VoicePayload | PhotoPayload;

export type QueueOperation = 'text' | 'voice' | 'photo';

export type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface QueueItem {
  id: number;
  chat_id: number;
  operation: QueueOperation;
  payload: string;
  status: QueueStatus;
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}
