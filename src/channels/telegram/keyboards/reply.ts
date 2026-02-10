/**
 * Telegram reply keyboard builder
 * Creates persistent reply keyboards at the bottom of the chat
 */

import { Keyboard } from 'grammy';
import { ReplyKeyboardButton, ReplyKeyboardRow } from '../types';

/**
 * Builder for Telegram reply keyboards (persistent keyboards)
 */
export class ReplyKeyboardBuilder {
  private rows: ReplyKeyboardRow[] = [];
  private resizeKeyboard: boolean = true;
  private oneTimeKeyboard: boolean = false;
  private inputFieldPlaceholder?: string;
  private selective: boolean = false;
  private isPersistent: boolean = true;

  /**
   * Add a row of buttons
   */
  addRow(buttons: ReplyKeyboardButton[]): this {
    this.rows.push(buttons);
    return this;
  }

  /**
   * Add a single button as its own row
   */
  addButton(text: string): this {
    this.rows.push([{ text }]);
    return this;
  }

  /**
   * Add a location request button
   */
  addLocationButton(text: string = 'Share Location'): this {
    this.rows.push([{ text, requestLocation: true }]);
    return this;
  }

  /**
   * Add a contact request button
   */
  addContactButton(text: string = 'Share Contact'): this {
    this.rows.push([{ text, requestContact: true }]);
    return this;
  }

  /**
   * Set whether the keyboard should be resized to fit
   */
  setResize(resize: boolean): this {
    this.resizeKeyboard = resize;
    return this;
  }

  /**
   * Set whether the keyboard should hide after use
   */
  setOneTime(oneTime: boolean): this {
    this.oneTimeKeyboard = oneTime;
    return this;
  }

  /**
   * Set whether the keyboard should persist
   */
  setPersistent(persistent: boolean): this {
    this.isPersistent = persistent;
    return this;
  }

  /**
   * Set placeholder text for the input field
   */
  setPlaceholder(placeholder: string): this {
    this.inputFieldPlaceholder = placeholder;
    return this;
  }

  /**
   * Set whether keyboard is selective (only for specific users)
   */
  setSelective(selective: boolean): this {
    this.selective = selective;
    return this;
  }

  /**
   * Build the grammy Keyboard
   */
  build(): Keyboard {
    let keyboard = new Keyboard();

    for (const row of this.rows) {
      for (const button of row) {
        if (button.requestLocation) {
          keyboard = keyboard.requestLocation(button.text);
        } else if (button.requestContact) {
          keyboard = keyboard.requestContact(button.text);
        } else {
          keyboard = keyboard.text(button.text);
        }
      }
      keyboard = keyboard.row();
    }

    if (this.resizeKeyboard) {
      keyboard = keyboard.resized();
    }

    if (this.oneTimeKeyboard) {
      keyboard = keyboard.oneTime();
    }

    if (this.isPersistent) {
      keyboard = keyboard.persistent();
    }

    if (this.selective) {
      keyboard = keyboard.selected();
    }

    if (this.inputFieldPlaceholder) {
      keyboard = keyboard.placeholder(this.inputFieldPlaceholder);
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
 * Create a default keyboard with common quick actions
 */
export function defaultKeyboard(): Keyboard {
  return new ReplyKeyboardBuilder()
    .addRow([
      { text: 'Tasks' },
      { text: 'Facts' },
    ])
    .addRow([
      { text: 'Reminders' },
      { text: 'Status' },
    ])
    .setPlaceholder('Type a message or tap a button...')
    .build();
}

/**
 * Create a context-aware keyboard based on current state
 */
export function contextKeyboard(context: 'idle' | 'task' | 'location' | 'reminder'): Keyboard {
  const builder = new ReplyKeyboardBuilder();

  switch (context) {
    case 'task':
      builder
        .addRow([
          { text: 'Mark Complete' },
          { text: 'Skip' },
        ])
        .addRow([
          { text: 'Reschedule' },
          { text: 'Cancel' },
        ]);
      break;

    case 'location':
      builder
        .addRow([
          { text: 'Nearby Restaurants' },
          { text: 'Nearby Cafes' },
        ])
        .addRow([
          { text: 'Weather Here' },
          { text: 'Directions Home' },
        ])
        .addLocationButton('Update Location');
      break;

    case 'reminder':
      builder
        .addRow([
          { text: 'In 10 minutes' },
          { text: 'In 1 hour' },
        ])
        .addRow([
          { text: 'Tomorrow' },
          { text: 'Custom Time' },
        ]);
      break;

    case 'idle':
    default:
      return defaultKeyboard();
  }

  return builder.build();
}

