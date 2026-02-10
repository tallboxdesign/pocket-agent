/**
 * Telegram location handler
 * Handles shared location and live location
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback, LocationData, GeocodingResult, LocationQuickAction } from '../types';
import { withTyping } from '../utils/typing';
import { InlineKeyboardBuilder } from '../keyboards/inline';

export interface LocationHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Reverse geocode coordinates using OpenStreetMap Nominatim
 */
async function reverseGeocode(lat: number, lon: number): Promise<GeocodingResult | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'PocketAgent/1.0 (personal assistant)',
      },
    });

    if (!response.ok) {
      console.warn('[Telegram] Nominatim request failed:', response.statusText);
      return null;
    }

    const data = await response.json();

    return {
      displayName: data.display_name || 'Unknown location',
      address: data.address ? {
        road: data.address.road,
        city: data.address.city || data.address.town || data.address.village,
        state: data.address.state,
        country: data.address.country,
        postcode: data.address.postcode,
      } : undefined,
    };
  } catch (error) {
    console.error('[Telegram] Geocoding error:', error);
    return null;
  }
}

/**
 * Get context-aware quick actions for a location
 */
function getLocationQuickActions(geocoding: GeocodingResult | null): LocationQuickAction[] {
  const actions: LocationQuickAction[] = [
    {
      label: 'Nearby restaurants',
      action: 'search_nearby',
      query: 'restaurants',
    },
    {
      label: 'Nearby cafes',
      action: 'search_nearby',
      query: 'cafes',
    },
    {
      label: 'Directions home',
      action: 'directions',
      query: 'home',
    },
  ];

  // Add weather action
  actions.push({
    label: 'Weather here',
    action: 'weather',
    query: geocoding?.address?.city || 'this location',
  });

  return actions;
}

/**
 * Handle incoming location messages
 */
export async function handleLocationMessage(
  ctx: Context,
  deps: LocationHandlerDeps
): Promise<void> {
  console.log('[Telegram] Location handler called');
  const chatId = ctx.chat?.id;
  const location = ctx.message?.location;

  console.log('[Telegram] Location data:', { chatId, hasLocation: !!location, location });

  if (!chatId || !location) {
    console.log('[Telegram] Location handler: missing chatId or location, returning');
    return;
  }

  const { onMessageCallback, sendResponse } = deps;

  const locationData: LocationData = {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.horizontal_accuracy,
    heading: location.heading,
    livePeriod: location.live_period,
  };

  const isLiveLocation = Boolean(location.live_period);

  try {
    const result = await withTyping(ctx, async () => {
      // Reverse geocode the location
      const geocoding = await reverseGeocode(locationData.latitude, locationData.longitude);

      console.log(
        `[Telegram] Processing location: ${locationData.latitude}, ${locationData.longitude}` +
        (geocoding ? ` (${geocoding.displayName.substring(0, 50)})` : '') +
        (isLiveLocation ? ' [LIVE]' : '')
      );

      // Build location description
      const locationDesc = geocoding?.displayName || `${locationData.latitude}, ${locationData.longitude}`;
      const addressParts: string[] = [];

      if (geocoding?.address) {
        if (geocoding.address.road) addressParts.push(geocoding.address.road);
        if (geocoding.address.city) addressParts.push(geocoding.address.city);
        if (geocoding.address.state) addressParts.push(geocoding.address.state);
        if (geocoding.address.country) addressParts.push(geocoding.address.country);
      }

      // Build prompt for agent
      const prompt = isLiveLocation
        ? `User is sharing their live location: ${locationDesc}\n\n` +
          `Coordinates: ${locationData.latitude}, ${locationData.longitude}\n` +
          (addressParts.length > 0 ? `Address: ${addressParts.join(', ')}\n` : '') +
          `This is a live location that will update in real-time.\n\n` +
          `Acknowledge that I can see their location and ask if they need help with anything location-related.`
        : `User shared their location: ${locationDesc}\n\n` +
          `Coordinates: ${locationData.latitude}, ${locationData.longitude}\n` +
          (addressParts.length > 0 ? `Address: ${addressParts.join(', ')}\n` : '') +
          `\nAcknowledge the location and offer helpful suggestions based on where they are.`;

      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      const agentResult = await AgentManager.processMessage(prompt, 'telegram', sessionId, undefined, {
        hasAttachment: true,
        attachmentType: 'location',
      });

      return {
        agentResult,
        geocoding,
      };
    });

    // Build quick action keyboard
    const quickActions = getLocationQuickActions(result.geocoding);
    const keyboard = new InlineKeyboardBuilder();

    // Add quick actions in rows of 2
    for (let i = 0; i < quickActions.length; i += 2) {
      const rowActions = quickActions.slice(i, i + 2);
      const buttons = rowActions.map(action => ({
        text: action.label,
        callbackData: `location:${action.action}:${action.query}`,
      }));
      keyboard.addRow(buttons);
    }

    // Send response with inline keyboard
    await sendResponse(ctx, result.agentResult.response);

    // Send quick actions as a separate message (optional, only if keyboard has buttons)
    if (quickActions.length > 0) {
      try {
        await ctx.reply('Quick actions:', {
          reply_markup: keyboard.build(),
        });
      } catch (error) {
        // Keyboard might fail if callback data is too long, silently ignore
        console.warn('[Telegram] Failed to send location keyboard:', error);
      }
    }

    // Send media photos if present
    if (result.agentResult.media && result.agentResult.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.agentResult.media);
      }
    }

    // Notify callback for cross-channel sync
    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';
      const locationStr = result.geocoding?.displayName ||
        `${locationData.latitude}, ${locationData.longitude}`;

      onMessageCallback({
        userMessage: `Shared location: ${locationStr}`,
        response: result.agentResult.response,
        channel: 'telegram',
        chatId,
        sessionId,
        hasAttachment: true,
        attachmentType: 'location',
        wasCompacted: result.agentResult.wasCompacted,
        media: result.agentResult.media,
      });
    }

    // If compaction happened, notify
    if (result.agentResult.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Location error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error processing location: ${errorMsg}`);
  }
}

/**
 * Handle edited location (live location updates)
 */
export async function handleEditedLocation(
  ctx: Context,
  _deps: LocationHandlerDeps
): Promise<void> {
  const chatId = ctx.editedMessage?.chat?.id;
  const location = ctx.editedMessage?.location;

  if (!chatId || !location) return;

  // For live location updates, we just log them
  // The agent doesn't need to respond to every position update
  console.log(
    `[Telegram] Live location update: ${location.latitude}, ${location.longitude}`
  );

  // Optionally, you could update a stored location state here
  // or notify the agent periodically about significant moves
}
