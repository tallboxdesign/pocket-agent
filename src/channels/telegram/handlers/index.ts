/**
 * Telegram handlers index
 */

export { registerCommandHandlers, registerSessionHandlers, CommandHandlerDeps } from './commands';
export { handleTextMessage, MessageHandlerDeps } from './messages';
export { handlePhotoMessage, handleVoiceMessage, handleAudioMessage, MediaHandlerDeps } from './media';
export { handleDocumentMessage, DocumentHandlerDeps } from './documents';
export { handleLocationMessage, handleEditedLocation, LocationHandlerDeps } from './location';
export { registerCallbackHandler, CallbackHandlerDeps } from './callbacks';
