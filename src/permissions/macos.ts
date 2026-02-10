/**
 * macOS Permission Detection and Management
 *
 * Handles checking and requesting macOS system permissions
 * required by various skills.
 */

import { systemPreferences, shell } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export type PermissionType =
  | 'accessibility'
  | 'screen-recording'
  | 'full-disk-access'
  | 'reminders'
  | 'contacts'
  | 'calendar'
  | 'camera'
  | 'microphone'
  | 'bluetooth'
  | 'automation';

export interface PermissionStatus {
  type: PermissionType;
  granted: boolean;
  canRequest: boolean;
  label: string;
  description: string;
  settingsUrl: string;
}

// Map permission types to System Settings URLs (macOS Ventura+)
const SETTINGS_URLS: Record<PermissionType, string> = {
  'accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  'full-disk-access': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  'reminders': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
  'contacts': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
  'calendar': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  'camera': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  'microphone': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'bluetooth': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth',
  'automation': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

const PERMISSION_INFO: Record<PermissionType, { label: string; description: string }> = {
  'accessibility': {
    label: 'Accessibility',
    description: 'Control your computer and other apps',
  },
  'screen-recording': {
    label: 'Screen Recording',
    description: 'Capture screen content and screenshots',
  },
  'full-disk-access': {
    label: 'Full Disk Access',
    description: 'Access files in protected locations',
  },
  'reminders': {
    label: 'Reminders',
    description: 'Read and create reminders',
  },
  'contacts': {
    label: 'Contacts',
    description: 'Access your contacts',
  },
  'calendar': {
    label: 'Calendar',
    description: 'Access your calendars and events',
  },
  'camera': {
    label: 'Camera',
    description: 'Use your camera',
  },
  'microphone': {
    label: 'Microphone',
    description: 'Use your microphone',
  },
  'bluetooth': {
    label: 'Bluetooth',
    description: 'Discover and connect to Bluetooth devices',
  },
  'automation': {
    label: 'Automation',
    description: 'Control other apps via AppleScript',
  },
};

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

/**
 * Check if a specific permission is granted
 */
export function checkPermission(type: PermissionType): boolean {
  if (!isMacOS()) {
    // Non-macOS platforms don't need these permissions
    return true;
  }

  switch (type) {
    case 'camera':
      return systemPreferences.getMediaAccessStatus('camera') === 'granted';

    case 'microphone':
      return systemPreferences.getMediaAccessStatus('microphone') === 'granted';

    case 'screen-recording':
      return systemPreferences.getMediaAccessStatus('screen') === 'granted';

    case 'accessibility':
      return systemPreferences.isTrustedAccessibilityClient(false);

    case 'full-disk-access':
      return checkFullDiskAccess();

    case 'reminders':
      return checkRemindersAccess();

    case 'contacts':
      return checkContactsAccess();

    case 'calendar':
      return checkCalendarAccess();

    case 'bluetooth':
      // Bluetooth permission is typically granted when needed
      // Hard to check programmatically, assume granted
      return true;

    case 'automation':
      // Automation permission is per-app and hard to check
      // Will be prompted when the app tries to use AppleScript
      return true;

    default:
      return false;
  }
}

/**
 * Check Full Disk Access by trying to read a protected file
 */
function checkFullDiskAccess(): boolean {
  try {
    // Try to read Safari's history - a protected location
    const safariHistory = `${os.homedir()}/Library/Safari/History.db`;
    fs.accessSync(safariHistory, fs.constants.R_OK);
    return true;
  } catch {
    // Try another protected location - Messages
    try {
      const messagesDb = `${os.homedir()}/Library/Messages/chat.db`;
      fs.accessSync(messagesDb, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Check Reminders access using remindctl if available
 */
function checkRemindersAccess(): boolean {
  try {
    const result = execSync('remindctl status 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.includes('authorized') || result.includes('granted');
  } catch {
    // If remindctl isn't installed or fails, we can't check
    // Return true to not block - permission will be requested on use
    return true;
  }
}

/**
 * Check Contacts access
 */
function checkContactsAccess(): boolean {
  try {
    // Try using contacts CLI or AppleScript
    execSync(
      'osascript -e \'tell application "Contacts" to count people\' 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check Calendar access
 */
function checkCalendarAccess(): boolean {
  try {
    execSync(
      'osascript -e \'tell application "Calendar" to count calendars\' 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get full status for a permission
 */
export function getPermissionStatus(type: PermissionType): PermissionStatus {
  const info = PERMISSION_INFO[type];
  const granted = checkPermission(type);
  const canRequest = ['camera', 'microphone', 'accessibility'].includes(type);

  return {
    type,
    granted,
    canRequest,
    label: info.label,
    description: info.description,
    settingsUrl: SETTINGS_URLS[type],
  };
}

/**
 * Get status of multiple permissions
 */
export function getPermissionsStatus(types: PermissionType[]): PermissionStatus[] {
  return types.map((type) => getPermissionStatus(type));
}

/**
 * Check which permissions from a list are missing
 */
export function getMissingPermissions(types: PermissionType[]): PermissionType[] {
  if (!isMacOS()) {
    return [];
  }
  return types.filter((type) => !checkPermission(type));
}

/**
 * Request a permission (only works for some types)
 */
export async function requestPermission(type: PermissionType): Promise<boolean> {
  if (!isMacOS()) {
    return true;
  }

  switch (type) {
    case 'camera':
      return (await systemPreferences.askForMediaAccess('camera'));

    case 'microphone':
      return (await systemPreferences.askForMediaAccess('microphone'));

    case 'accessibility':
      // This will show the system prompt
      return systemPreferences.isTrustedAccessibilityClient(true);

    default:
      // For other permissions, open System Settings
      await openPermissionSettings(type);
      return false;
  }
}

/**
 * Open System Settings to the permission page
 */
export async function openPermissionSettings(type: PermissionType): Promise<void> {
  if (!isMacOS()) {
    // Windows: open the Settings app to the relevant privacy page
    const winSettingsMap: Partial<Record<PermissionType, string>> = {
      'camera': 'ms-settings:privacy-webcam',
      'microphone': 'ms-settings:privacy-microphone',
      'calendar': 'ms-settings:privacy-calendar',
      'contacts': 'ms-settings:privacy-contacts',
    };
    const winUrl = winSettingsMap[type];
    if (winUrl) {
      await shell.openExternal(winUrl);
    }
    return;
  }

  const url = SETTINGS_URLS[type];
  if (url) {
    await shell.openExternal(url);
  }
}

/**
 * Get all permission types
 */
export function getAllPermissionTypes(): PermissionType[] {
  return Object.keys(SETTINGS_URLS) as PermissionType[];
}
