import { Context, Bot } from 'grammy';

/**
 * Attachment types supported by Telegram channel
 */
export type AttachmentType = 'photo' | 'voice' | 'audio' | 'document' | 'location';

/**
 * Callback for message processing (cross-channel sync)
 */
export type MessageCallback = (data: {
  userMessage: string;
  response: string;
  channel: 'telegram';
  chatId: number;
  sessionId: string;
  hasAttachment?: boolean;
  attachmentType?: AttachmentType;
  wasCompacted?: boolean;
  media?: Array<{ type: string; filePath: string; mimeType: string }>;
}) => void;

/**
 * Callback for session linking events
 */
export type SessionLinkCallback = (data: {
  sessionId: string;
  linked: boolean;
}) => void;

/**
 * Inline keyboard button definition
 */
export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

/**
 * Inline keyboard row (array of buttons)
 */
export type InlineKeyboardRow = InlineKeyboardButton[];

/**
 * Document types for categorization
 */
export type DocumentType = 'pdf' | 'code' | 'spreadsheet' | 'text' | 'unknown';

/**
 * Metadata for received documents
 */
export interface DocumentMetadata {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  documentType: DocumentType;
}

/**
 * Location data from Telegram
 */
export interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  livePeriod?: number;
}

/**
 * Reverse geocoding result
 */
export interface GeocodingResult {
  displayName: string;
  address?: {
    road?: string;
    city?: string;
    state?: string;
    country?: string;
    postcode?: string;
  };
}

/**
 * Standard Telegram reaction emojis
 */
export type ReactionEmoji =
  | '👍' | '👎' | '❤️' | '🔥' | '🥰' | '👏' | '😁' | '🤔'
  | '🤯' | '😱' | '🤬' | '😢' | '🎉' | '🤩' | '🤮' | '💩'
  | '🙏' | '👌' | '🕊' | '🤡' | '🥱' | '🥴' | '😍' | '🐳'
  | '❤️‍🔥' | '🌚' | '🌭' | '💯' | '🤣' | '⚡' | '🍌' | '🏆'
  | '💔' | '🤨' | '😐' | '🍓' | '🍾' | '💋' | '🖕' | '😈'
  | '😴' | '😭' | '🤓' | '👻' | '👨‍💻' | '👀' | '🎃' | '🙈'
  | '😇' | '😨' | '🤝' | '✍️' | '🤗' | '🫡' | '🎅' | '🎄'
  | '☃️' | '💅' | '🤪' | '🗿' | '🆒' | '💘' | '🙉' | '🦄'
  | '😘' | '💊' | '🙊' | '😎' | '👾' | '🤷' | '🤷‍♂️' | '🤷‍♀️';

/**
 * Reaction event data
 */
export interface ReactionData {
  chatId: number;
  messageId: number;
  userId: number;
  emoji: ReactionEmoji;
  isAdded: boolean;
}

/**
 * Reply keyboard button
 */
export interface ReplyKeyboardButton {
  text: string;
  requestContact?: boolean;
  requestLocation?: boolean;
}

/**
 * Reply keyboard row
 */
export type ReplyKeyboardRow = ReplyKeyboardButton[];

/**
 * Handler context with bot reference
 */
export interface HandlerContext {
  bot: Bot;
  ctx: Context;
  chatId: number;
  sessionId: string;
}

/**
 * Result from handler processing
 */
export interface HandlerResult {
  handled: boolean;
  response?: string;
  error?: string;
}

/**
 * File download result
 */
export interface DownloadResult {
  success: boolean;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  error?: string;
}

/**
 * Callback query data parsed from inline keyboards
 */
export interface CallbackQueryData {
  action: string;
  payload?: string;
  page?: number;
}

/**
 * Quick action for location-based suggestions
 */
export interface LocationQuickAction {
  label: string;
  action: string;
  query: string;
}
