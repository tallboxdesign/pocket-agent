/**
 * Telegram inline keyboard builder
 * Creates inline keyboards for interactive messages
 */

import { InlineKeyboard } from 'grammy';
import { InlineKeyboardButton, InlineKeyboardRow } from '../types';

/**
 * Builder for Telegram inline keyboards
 */
export class InlineKeyboardBuilder {
  private rows: InlineKeyboardRow[] = [];

  /**
   * Add a row of buttons
   */
  addRow(buttons: InlineKeyboardButton[]): this {
    this.rows.push(buttons);
    return this;
  }

  /**
   * Add a single button as its own row
   */
  addButton(text: string, callbackData: string): this {
    this.rows.push([{ text, callbackData }]);
    return this;
  }

  /**
   * Build the grammy InlineKeyboard
   */
  build(): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const row of this.rows) {
      for (const button of row) {
        keyboard.text(button.text, button.callbackData);
      }
      keyboard.row();
    }

    return keyboard;
  }

  /**
   * Clear all buttons
   */
  clear(): this {
    this.rows = [];
    return this;
  }

  /**
   * Check if keyboard has any buttons
   */
  isEmpty(): boolean {
    return this.rows.length === 0;
  }
}

/**
 * Create a confirmation dialog keyboard
 */
export function confirmationKeyboard(actionId: string, yesLabel = 'Yes', noLabel = 'No'): InlineKeyboard {
  return new InlineKeyboardBuilder()
    .addRow([
      { text: yesLabel, callbackData: `confirm:${actionId}:yes` },
      { text: noLabel, callbackData: `confirm:${actionId}:no` },
    ])
    .build();
}

/**
 * Create a paginated list keyboard
 */
export function paginationKeyboard(
  currentPage: number,
  totalPages: number,
  prefix: string = 'page'
): InlineKeyboard {
  const builder = new InlineKeyboardBuilder();
  const buttons: InlineKeyboardButton[] = [];

  // Previous button
  if (currentPage > 0) {
    buttons.push({
      text: '<< Prev',
      callbackData: `${prefix}:${currentPage - 1}`,
    });
  }

  // Page indicator
  buttons.push({
    text: `${currentPage + 1}/${totalPages}`,
    callbackData: `${prefix}:current`, // No-op, just shows current page
  });

  // Next button
  if (currentPage < totalPages - 1) {
    buttons.push({
      text: 'Next >>',
      callbackData: `${prefix}:${currentPage + 1}`,
    });
  }

  builder.addRow(buttons);
  return builder.build();
}

/**
 * Create a simple options keyboard from a list of items
 */
export function optionsKeyboard(
  options: Array<{ label: string; value: string }>,
  actionPrefix: string,
  columns: number = 2
): InlineKeyboard {
  const builder = new InlineKeyboardBuilder();

  for (let i = 0; i < options.length; i += columns) {
    const rowOptions = options.slice(i, i + columns);
    const buttons = rowOptions.map(opt => ({
      text: opt.label,
      callbackData: `${actionPrefix}:${opt.value}`,
    }));
    builder.addRow(buttons);
  }

  return builder.build();
}

/**
 * Create a rating keyboard (1-5 stars or similar)
 */
export function ratingKeyboard(
  messageId: string,
  maxRating: number = 5
): InlineKeyboard {
  const builder = new InlineKeyboardBuilder();
  const buttons: InlineKeyboardButton[] = [];

  for (let i = 1; i <= maxRating; i++) {
    const stars = '*'.repeat(i);
    buttons.push({
      text: stars,
      callbackData: `rate:${messageId}:${i}`,
    });
  }

  builder.addRow(buttons);
  return builder.build();
}

/**
 * Create a cancel-only keyboard
 */
export function cancelKeyboard(actionId: string): InlineKeyboard {
  return new InlineKeyboardBuilder()
    .addButton('Cancel', `confirm:${actionId}:no`)
    .build();
}

/**
 * Create a URL button keyboard (for linking to external resources)
 */
export function urlKeyboard(text: string, url: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.url(text, url);
  return keyboard;
}

/**
 * Create a mixed keyboard with callback and URL buttons
 */
export function mixedKeyboard(
  callbackButtons: InlineKeyboardButton[],
  urlButtons: Array<{ text: string; url: string }>
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Add callback buttons
  for (const button of callbackButtons) {
    keyboard.text(button.text, button.callbackData);
  }
  keyboard.row();

  // Add URL buttons
  for (const button of urlButtons) {
    keyboard.url(button.text, button.url);
  }

  return keyboard;
}
