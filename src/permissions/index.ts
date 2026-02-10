/**
 * Cross-platform Permission Management
 *
 * Re-exports from platform-specific modules.
 * macOS: Full permission checking via system APIs
 * Windows/Linux: Permissions are generally not gated the same way;
 *   returns granted for all checks.
 */

export {
  type PermissionType,
  type PermissionStatus,
  isMacOS,
  checkPermission,
  getPermissionStatus,
  getPermissionsStatus,
  getMissingPermissions,
  requestPermission,
  openPermissionSettings,
  getAllPermissionTypes,
} from './macos';
