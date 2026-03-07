/**
 * Pre-tool-use safety validation for Pocket Agent
 *
 * Blocks dangerous commands that should NEVER be executed under any circumstances.
 * These patterns represent catastrophic operations with no legitimate use case.
 */

import path from 'path';
import { SettingsManager } from '../settings';
import { getCurrentSessionId } from '../tools/session-context';

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

interface ExternalApprovalRequest {
  sessionId: string;
  toolName: string;
  command: string;
  normalizedCommand: string;
  requestedAt: number;
}

export type ExternalActionAuditStatus =
  | 'requested'
  | 'approved'
  | 'approved_executed'
  | 'denied'
  | 'approval_mismatch'
  | 'allowed_by_setting'
  | 'expired';

export interface ExternalActionAuditEntry {
  id: number;
  status: ExternalActionAuditStatus;
  sessionId: string;
  toolName: string;
  command: string;
  reason?: string;
  createdAt: number;
}

export interface ExternalSafetyState {
  allowHostIntegrations: boolean;
  pendingApprovals: Array<{
    sessionId: string;
    toolName: string;
    command: string;
    requestedAt: number;
  }>;
  oneShotApprovals: number;
  auditEntries: number;
}

export interface ExternalRegressionCheck {
  id: string;
  label: string;
  pass: boolean;
  details: string;
}

export interface ExternalRegressionReport {
  generatedAt: string;
  passed: number;
  failed: number;
  checks: ExternalRegressionCheck[];
}

const pendingExternalApprovals = new Map<string, ExternalApprovalRequest>();
const approvedExternalCommands = new Map<string, { normalizedCommand: string; approvedAt: number }>();
const EXTERNAL_APPROVAL_TTL_MS = 10 * 60 * 1000;
const externalActionAuditTrail: ExternalActionAuditEntry[] = [];
const MAX_EXTERNAL_AUDIT_TRAIL = 500;
let externalActionAuditId = 0;

function recordExternalAudit(
  status: ExternalActionAuditStatus,
  request: Pick<ExternalApprovalRequest, 'sessionId' | 'toolName' | 'command'>,
  reason?: string
): void {
  externalActionAuditTrail.push({
    id: ++externalActionAuditId,
    status,
    sessionId: request.sessionId,
    toolName: request.toolName,
    command: request.command,
    reason,
    createdAt: Date.now(),
  });
  if (externalActionAuditTrail.length > MAX_EXTERNAL_AUDIT_TRAIL) {
    externalActionAuditTrail.splice(0, externalActionAuditTrail.length - MAX_EXTERNAL_AUDIT_TRAIL);
  }
}

function normalizeCommand(command: string): string {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function pruneStaleApprovals(): void {
  const now = Date.now();
  for (const [sessionId, req] of pendingExternalApprovals.entries()) {
    if (now - req.requestedAt > EXTERNAL_APPROVAL_TTL_MS) {
      pendingExternalApprovals.delete(sessionId);
      recordExternalAudit('expired', req, 'Pending approval timed out');
    }
  }
  for (const [sessionId, approved] of approvedExternalCommands.entries()) {
    if (now - approved.approvedAt > EXTERNAL_APPROVAL_TTL_MS) {
      approvedExternalCommands.delete(sessionId);
    }
  }
}

export function getPendingExternalApproval(sessionId: string): ExternalApprovalRequest | null {
  pruneStaleApprovals();
  return pendingExternalApprovals.get(sessionId) || null;
}

export function clearPendingExternalApproval(sessionId: string): void {
  const pending = pendingExternalApprovals.get(sessionId);
  if (pending) {
    recordExternalAudit('denied', pending, 'Cleared by user');
  }
  pendingExternalApprovals.delete(sessionId);
  approvedExternalCommands.delete(sessionId);
}

export function approvePendingExternalApproval(
  sessionId: string,
  explicitCommand?: string
): { ok: boolean; command?: string; message: string } {
  pruneStaleApprovals();
  const pending = pendingExternalApprovals.get(sessionId);
  if (!pending) {
    recordExternalAudit(
      'denied',
      {
        sessionId,
        toolName: 'Bash',
        command: explicitCommand || '(none)',
      },
      'No pending external action to approve'
    );
    return { ok: false, message: 'No pending external action to approve.' };
  }

  if (explicitCommand) {
    const explicitNormalized = normalizeCommand(explicitCommand);
    if (explicitNormalized !== pending.normalizedCommand) {
      recordExternalAudit('approval_mismatch', pending, 'Explicit command does not match pending request');
      return {
        ok: false,
        message: 'Approval mismatch. Please approve the exact command shown in the prompt.',
      };
    }
  }

  approvedExternalCommands.set(sessionId, {
    normalizedCommand: pending.normalizedCommand,
    approvedAt: Date.now(),
  });
  recordExternalAudit('approved', pending);
  pendingExternalApprovals.delete(sessionId);
  return { ok: true, command: pending.command, message: 'External command approved for one execution.' };
}

export function getExternalActionAudit(limit: number = 50): ExternalActionAuditEntry[] {
  pruneStaleApprovals();
  return externalActionAuditTrail.slice(-Math.max(1, limit)).reverse();
}

export function clearExternalActionAudit(): void {
  externalActionAuditTrail.length = 0;
}

export function getExternalSafetyState(): ExternalSafetyState {
  pruneStaleApprovals();
  return {
    allowHostIntegrations: SettingsManager.get('agent.allowHostIntegrations') === 'true',
    pendingApprovals: Array.from(pendingExternalApprovals.values()).map((req) => ({
      sessionId: req.sessionId,
      toolName: req.toolName,
      command: req.command,
      requestedAt: req.requestedAt,
    })),
    oneShotApprovals: approvedExternalCommands.size,
    auditEntries: externalActionAuditTrail.length,
  };
}

// ============================================================================
// DANGEROUS BASH PATTERNS - Commands that should NEVER be run
// ============================================================================

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // ─────────────────────────────────────────────────────────────────────────
  // SYSTEM DESTRUCTION
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /rm\s+(-[rfRF]+\s+)*[/~]\s*$/,
    reason: 'Attempted to delete root or home directory',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\/\*/,
    reason: 'Attempted to delete all files from root',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*~\//,
    reason: 'Attempted to delete home directory contents',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\$HOME/i,
    reason: 'Attempted to delete home directory contents',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\/etc\b/,
    reason: 'Attempted to delete system configuration',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\/boot\b/,
    reason: 'Attempted to delete boot partition',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\/usr\b/,
    reason: 'Attempted to delete system binaries',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\/var\b/,
    reason: 'Attempted to delete system data',
  },
  {
    pattern: /rm\s+(-[rfRF]+\s+)*\/System\b/i,
    reason: 'Attempted to delete macOS system files',
  },

  // DD to block devices
  {
    pattern: /dd\s+.*of=\/dev\/(sd[a-z]|disk\d|nvme|hd[a-z])/i,
    reason: 'Attempted to overwrite disk device',
  },
  {
    pattern: />\s*\/dev\/(sd[a-z]|disk\d|nvme|hd[a-z])/i,
    reason: 'Attempted to redirect to disk device',
  },

  // Filesystem formatting
  {
    pattern: /mkfs\./i,
    reason: 'Attempted to format filesystem',
  },
  {
    pattern: /wipefs/i,
    reason: 'Attempted to wipe filesystem signatures',
  },

  // Fork bomb
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/,
    reason: 'Fork bomb detected',
  },
  {
    pattern: /fork\s+while\s+fork/i,
    reason: 'Fork bomb variant detected',
  },
  {
    pattern: /\.\s*\/dev\/tcp/,
    reason: 'Potential fork bomb via /dev/tcp',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SYSTEM SHUTDOWN / HALT
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /\b(shutdown|poweroff|halt)\b/i,
    reason: 'System shutdown command blocked',
  },
  {
    pattern: /\breboot\b/i,
    reason: 'System reboot command blocked',
  },
  {
    pattern: /\binit\s+[06]\b/,
    reason: 'Runlevel shutdown/reboot blocked',
  },
  {
    pattern: /systemctl\s+(reboot|poweroff|halt)/i,
    reason: 'Systemd shutdown command blocked',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // KILL INIT / ALL PROCESSES
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /kill\s+(-9\s+)?1\b/,
    reason: 'Attempted to kill init process',
  },
  {
    pattern: /kill\s+-9\s+-1\b/,
    reason: 'Attempted to kill all processes',
  },
  {
    pattern: /kill\s+.*SIGKILL.*\s+1\b/i,
    reason: 'Attempted to SIGKILL init process',
  },
  {
    pattern: /pkill\s+(-9\s+)?init/i,
    reason: 'Attempted to kill init process',
  },
  {
    pattern: /killall\s+(-9\s+)?init/i,
    reason: 'Attempted to kill init process',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // REVERSE SHELLS / BACKDOORS
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /\/dev\/tcp\//,
    reason: 'Reverse shell via /dev/tcp detected',
  },
  {
    pattern: /\/dev\/udp\//,
    reason: 'Reverse shell via /dev/udp detected',
  },
  {
    pattern: /bash\s+-i\s+>&?\s*\/dev\//,
    reason: 'Interactive bash reverse shell detected',
  },
  {
    pattern: /nc\s+.*-[ec]\s+\/bin/i,
    reason: 'Netcat reverse shell detected',
  },
  {
    pattern: /ncat\s+.*--exec/i,
    reason: 'Ncat reverse shell detected',
  },
  {
    pattern: /socat\s+.*exec:/i,
    reason: 'Socat reverse shell detected',
  },
  {
    pattern: /telnet\s+.*\|\s*\/bin/i,
    reason: 'Telnet reverse shell detected',
  },
  {
    pattern: /mkfifo\s+.*nc\s+/i,
    reason: 'Named pipe reverse shell detected',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SECURITY BYPASS / DISABLE
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /csrutil\s+disable/i,
    reason: 'Attempted to disable macOS SIP',
  },
  {
    pattern: /setenforce\s+0/i,
    reason: 'Attempted to disable SELinux',
  },
  {
    pattern: /spctl\s+--master-disable/i,
    reason: 'Attempted to disable macOS Gatekeeper',
  },
  {
    pattern: /ufw\s+disable/i,
    reason: 'Attempted to disable firewall',
  },
  {
    pattern: /iptables\s+-F/i,
    reason: 'Attempted to flush all firewall rules',
  },
  {
    pattern: /systemctl\s+(stop|disable)\s+firewalld/i,
    reason: 'Attempted to disable firewall service',
  },
  {
    pattern: /pfctl\s+-d/i,
    reason: 'Attempted to disable macOS packet filter',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // HISTORY WIPING / COVERING TRACKS
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /history\s+-c/i,
    reason: 'Attempted to clear command history',
  },
  {
    pattern: />\s*~\/\.(bash|zsh|sh)_history/i,
    reason: 'Attempted to wipe shell history',
  },
  {
    pattern: /rm\s+.*\.(bash|zsh|sh)_history/i,
    reason: 'Attempted to delete shell history',
  },
  {
    pattern: /unset\s+HISTFILE/i,
    reason: 'Attempted to disable history logging',
  },
  {
    pattern: /export\s+HISTSIZE=0/i,
    reason: 'Attempted to disable history',
  },
  {
    pattern: /shred\s+.*history/i,
    reason: 'Attempted to destroy history file',
  },
  {
    pattern: /truncate\s+.*history/i,
    reason: 'Attempted to truncate history file',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CATASTROPHIC PERMISSION CHANGES
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /chmod\s+(-R\s+)?777\s+\//,
    reason: 'Attempted to make root world-writable',
  },
  {
    pattern: /chmod\s+(-R\s+)?777\s+\/\*/,
    reason: 'Attempted to make all root contents world-writable',
  },
  {
    pattern: /chown\s+-R\s+.*\s+\//,
    reason: 'Attempted to recursively change root ownership',
  },
  {
    pattern: /chmod\s+[ugo]?\+s\s+\//,
    reason: 'Attempted to set SUID/SGID on root',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // PIPE TO SHELL FROM INTERNET
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /curl\s+[^|]*\|\s*(sudo\s+)?(ba)?sh/i,
    reason: 'Pipe from curl to shell blocked',
  },
  {
    pattern: /wget\s+[^|]*\|\s*(sudo\s+)?(ba)?sh/i,
    reason: 'Pipe from wget to shell blocked',
  },
  {
    pattern: /curl\s+[^|]*\|\s*(sudo\s+)?python/i,
    reason: 'Pipe from curl to python blocked',
  },
  {
    pattern: /wget\s+[^|]*\|\s*(sudo\s+)?python/i,
    reason: 'Pipe from wget to python blocked',
  },
  {
    pattern: /curl\s+[^|]*\|\s*(sudo\s+)?perl/i,
    reason: 'Pipe from curl to perl blocked',
  },
  {
    pattern: /curl\s+[^|]*\|\s*(sudo\s+)?ruby/i,
    reason: 'Pipe from curl to ruby blocked',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CRITICAL FILE DESTRUCTION
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: />\s*\/etc\/(passwd|shadow|sudoers)/i,
    reason: 'Attempted to overwrite critical auth file',
  },
  {
    pattern: /rm\s+.*\/etc\/(passwd|shadow|sudoers)/i,
    reason: 'Attempted to delete critical auth file',
  },
  {
    pattern: /truncate\s+.*\/etc\/(passwd|shadow)/i,
    reason: 'Attempted to truncate critical auth file',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CRYPTO MINING / MALWARE PATTERNS
  // ─────────────────────────────────────────────────────────────────────────
  {
    pattern: /xmrig|cryptonight|monero.*miner|coinhive/i,
    reason: 'Cryptocurrency mining software detected',
  },
  {
    pattern: /stratum\+tcp:\/\//i,
    reason: 'Mining pool connection detected',
  },
];

const HOST_INTEGRATION_BASH_PATTERNS: RegExp[] = [
  /\bpocket\s+system\b/i,
  /\bosascript\b/i,
  /\bremindctl\b/i,
  /\bthings\s+add\b/i,
];

function findDangerousBashReason(normalizedCommand: string): string | null {
  for (const { pattern, reason } of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(normalizedCommand)) return reason;
  }
  return null;
}

export function runExternalActionRegression(): ExternalRegressionReport {
  const checks: ExternalRegressionCheck[] = [];

  const hostProbe = normalizeCommand('pocket system notes write "hello"');
  checks.push({
    id: 'host_requires_approval',
    label: 'Host integrations are guarded by explicit approval',
    pass: HOST_INTEGRATION_BASH_PATTERNS.some((pattern) => pattern.test(hostProbe)),
    details: 'Expected host command to match approval guard patterns',
  });

  const safeProbe = normalizeCommand('echo "safe command"');
  checks.push({
    id: 'safe_command_allowed',
    label: 'Safe shell command remains allowed',
    pass: !findDangerousBashReason(safeProbe),
    details: 'Expected no dangerous pattern match for a simple echo command',
  });

  const destructiveProbe = normalizeCommand('rm -rf /');
  const destructiveReason = findDangerousBashReason(destructiveProbe);
  checks.push({
    id: 'destructive_command_blocked',
    label: 'Destructive shell command is blocked',
    pass: !!destructiveReason,
    details: destructiveReason || 'Expected destructive command to be denied by dangerous pattern list',
  });

  const now = new Date().toISOString();
  const passed = checks.filter((c) => c.pass).length;
  return {
    generatedAt: now,
    passed,
    failed: checks.length - passed,
    checks,
  };
}

// ============================================================================
// DANGEROUS FILE PATHS - Paths that should never be written to
// ============================================================================

const DANGEROUS_WRITE_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  // System directories
  {
    pattern: /^\/etc\//,
    reason: 'Cannot write to system configuration directory',
  },
  {
    pattern: /^\/usr\//,
    reason: 'Cannot write to system binaries directory',
  },
  {
    pattern: /^\/var\//,
    reason: 'Cannot write to system data directory',
  },
  {
    pattern: /^\/bin\//,
    reason: 'Cannot write to system binaries',
  },
  {
    pattern: /^\/sbin\//,
    reason: 'Cannot write to system binaries',
  },
  {
    pattern: /^\/boot\//,
    reason: 'Cannot write to boot partition',
  },
  {
    pattern: /^\/System\//i,
    reason: 'Cannot write to macOS system directory',
  },
  {
    pattern: /^\/Library\//i,
    reason: 'Cannot write to macOS system library',
  },

  // Sensitive user directories
  {
    pattern: /^~\/\.ssh\//,
    reason: 'Cannot write to SSH directory',
  },
  {
    pattern: /^\/.*\/\.ssh\//,
    reason: 'Cannot write to SSH directory',
  },
  {
    pattern: /^~\/\.gnupg\//,
    reason: 'Cannot write to GPG directory',
  },
  {
    pattern: /^~\/\.aws\//,
    reason: 'Cannot write to AWS credentials directory',
  },
  {
    pattern: /^~\/\.kube\//,
    reason: 'Cannot write to Kubernetes config directory',
  },
  {
    pattern: /^~\/\.docker\//,
    reason: 'Cannot write to Docker config directory',
  },

  // Browser profile directories (credential theft)
  {
    pattern: /Chrome.*\/Default\//i,
    reason: 'Cannot write to Chrome profile',
  },
  {
    pattern: /Firefox.*\/Profiles\//i,
    reason: 'Cannot write to Firefox profile',
  },
  {
    pattern: /Safari.*\/Cookies/i,
    reason: 'Cannot write to Safari data',
  },

  // Keychain / credential stores
  {
    pattern: /Keychains?\//i,
    reason: 'Cannot write to keychain directory',
  },
  {
    pattern: /\.keychain/i,
    reason: 'Cannot write to keychain file',
  },

  // Windows system directories
  {
    pattern: /^[A-Z]:\\Windows\\/i,
    reason: 'Cannot write to Windows system directory',
  },
  {
    pattern: /^[A-Z]:\\Windows$/i,
    reason: 'Cannot write to Windows system directory',
  },
  {
    pattern: /^[A-Z]:\\Program Files( \(x86\))?\\/i,
    reason: 'Cannot write to Program Files directory',
  },
  {
    pattern: /^[A-Z]:\\ProgramData\\/i,
    reason: 'Cannot write to ProgramData directory',
  },
  {
    pattern: /\\System32\\/i,
    reason: 'Cannot write to System32 directory',
  },
  {
    pattern: /\\SysWOW64\\/i,
    reason: 'Cannot write to SysWOW64 directory',
  },

  // Windows special device paths
  {
    pattern: /^\\\\\.\\/,
    reason: 'Cannot write to device path',
  },
  {
    pattern: /^\\\\\?\\/,
    reason: 'Cannot write to extended-length path',
  },

  // Windows credential / sensitive user directories
  {
    pattern: /\\\.ssh\\/i,
    reason: 'Cannot write to SSH directory',
  },
  {
    pattern: /\\\.gnupg\\/i,
    reason: 'Cannot write to GPG directory',
  },
  {
    pattern: /\\\.aws\\/i,
    reason: 'Cannot write to AWS credentials directory',
  },
  {
    pattern: /\\Credentials\\/i,
    reason: 'Cannot write to Windows Credentials directory',
  },
];

// ============================================================================
// DANGEROUS BROWSER PATTERNS
// ============================================================================

const DANGEROUS_BROWSER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^file:\/\//i,
    reason: 'Local file access via browser blocked',
  },
  {
    pattern: /^chrome:\/\//i,
    reason: 'Browser internal URL blocked',
  },
  {
    pattern: /^about:/i,
    reason: 'Browser internal URL blocked',
  },
  {
    pattern: /^chrome-extension:\/\//i,
    reason: 'Extension URL blocked',
  },
];

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate a Bash command against dangerous patterns
 */
export function validateBashCommand(command: string): ValidationResult {
  pruneStaleApprovals();
  const normalizedCommand = normalizeCommand(command);
  const sessionId = getCurrentSessionId();

  const isHostIntegration = HOST_INTEGRATION_BASH_PATTERNS.some((pattern) =>
    pattern.test(normalizedCommand)
  );
  if (isHostIntegration) {
    const approved = approvedExternalCommands.get(sessionId);
    if (approved && approved.normalizedCommand === normalizedCommand) {
      approvedExternalCommands.delete(sessionId);
      recordExternalAudit(
        'approved_executed',
        {
          sessionId,
          toolName: 'Bash',
          command: command.trim(),
        },
        'Approved one-shot external command executed'
      );
      return { allowed: true };
    }

    const hostIntegrationsEnabled = SettingsManager.get('agent.allowHostIntegrations') === 'true';
    if (!hostIntegrationsEnabled) {
      return {
        allowed: false,
        reason:
          'Host integrations are disabled in Settings. Enable "Allow Host Integrations" first, then approve each external command explicitly.',
      };
    }

    const nextRequest: ExternalApprovalRequest = {
      sessionId,
      toolName: 'Bash',
      command: command.trim(),
      normalizedCommand,
      requestedAt: Date.now(),
    };
    const previous = pendingExternalApprovals.get(sessionId);
    pendingExternalApprovals.set(sessionId, nextRequest);
    if (!previous || previous.normalizedCommand !== nextRequest.normalizedCommand) {
      recordExternalAudit('requested', nextRequest, 'Host integration command needs explicit approval');
    }
    const shownCmd =
      normalizedCommand.length > 260
        ? normalizedCommand.slice(0, 260) + '...'
        : normalizedCommand;
    return {
      allowed: false,
      reason:
        `External command needs approval.\n` +
        `Command: ${shownCmd}\n` +
        `Ask user to confirm: "approve external: ${shownCmd}"\n` +
        `Or disable host integration requests for this task.`,
    };
  }

  const dangerousReason = findDangerousBashReason(normalizedCommand);
  if (dangerousReason) {
    console.warn(`[Safety] BLOCKED bash command: ${dangerousReason}`);
    console.warn(`[Safety] Command was: ${normalizedCommand.slice(0, 100)}...`);
    return { allowed: false, reason: dangerousReason };
  }

  return { allowed: true };
}

/**
 * Validate a file path for write operations
 */
export function validateWritePath(filePath: string): ValidationResult {
  // Expand ~ to home directory for pattern matching (cross-platform)
  const homeDir = process.env.HOME || process.env.USERPROFILE || (process.platform === 'win32' ? 'C:\\Users\\user' : '/home/user');
  const expandedPath = filePath.replace(/^~/, homeDir);

  // Normalize to resolve ../ traversal attempts and canonicalize separators
  const normalizedPath = path.resolve(expandedPath);

  for (const { pattern, reason } of DANGEROUS_WRITE_PATHS) {
    if (pattern.test(filePath) || pattern.test(expandedPath) || pattern.test(normalizedPath)) {
      console.warn(`[Safety] BLOCKED write path: ${reason}`);
      console.warn(`[Safety] Path was: ${filePath}`);
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}

/**
 * Validate a browser URL
 */
export function validateBrowserUrl(url: string): ValidationResult {
  for (const { pattern, reason } of DANGEROUS_BROWSER_PATTERNS) {
    if (pattern.test(url)) {
      console.warn(`[Safety] BLOCKED browser URL: ${reason}`);
      console.warn(`[Safety] URL was: ${url}`);
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}

/**
 * Main validation function for tool calls
 * Called by the SDK's canUseTool callback
 */
export function validateToolCall(
  toolName: string,
  input: Record<string, unknown>
): ValidationResult {
  // Bash command validation
  if (toolName === 'Bash') {
    const command = (input.command as string) || '';
    return validateBashCommand(command);
  }

  // Write/Edit file validation
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = (input.file_path as string) || '';
    return validateWritePath(filePath);
  }

  // Browser URL validation
  if (toolName === 'mcp__pocket-agent__browser') {
    const url = (input.url as string) || '';
    const action = (input.action as string) || '';

    if (action === 'navigate' && url) {
      return validateBrowserUrl(url);
    }
  }

  // All other tools pass through
  return { allowed: true };
}

/**
 * Build the canUseTool callback for SDK options
 */
export function buildCanUseToolCallback(): (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string }
) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: boolean }> {
  return async (toolName, input) => {
    console.log(`[Safety] canUseTool called for: ${toolName}`);
    const validation = validateToolCall(toolName, input);

    if (!validation.allowed) {
      console.log(`[Safety] DENIED: ${validation.reason}`);
      return {
        behavior: 'deny',
        message: `🚫 Safety block: ${validation.reason}`,
        interrupt: false, // Don't interrupt the entire session, just block this tool
      };
    }

    console.log(`[Safety] ALLOWED: ${toolName}`);
    return { behavior: 'allow' };
  };
}

// Status emitter type for UI updates
type StatusEmitter = (status: {
  type: 'tool_blocked';
  toolName: string;
  message: string;
  blockedReason: string;
}) => void;

// Module-level status emitter (set by agent)
let statusEmitter: StatusEmitter | null = null;

/**
 * Set the status emitter for UI updates when tools are blocked
 */
export function setStatusEmitter(emitter: StatusEmitter): void {
  statusEmitter = emitter;
}

/**
 * Build PreToolUse hook for SDK options
 * Returns { hookSpecificOutput: { permissionDecision: 'deny' } } to block tools
 * See: https://github.com/anthropics/claude-code/issues/4362
 */
export function buildPreToolUseHook(): {
  hooks: Array<(input: { tool_name: string; tool_input: unknown }) => Promise<{
    hookSpecificOutput: {
      hookEventName: 'PreToolUse';
      permissionDecision: 'allow' | 'deny';
      permissionDecisionReason?: string;
    };
  }>>;
} {
  return {
    hooks: [
      async (input: { tool_name: string; tool_input: unknown }) => {
        console.log(`[Safety] PreToolUse hook called for: ${input.tool_name}`);
        const validation = validateToolCall(
          input.tool_name,
          (input.tool_input as Record<string, unknown>) || {}
        );

        if (!validation.allowed) {
          console.log(`[Safety] HOOK DENIED: ${validation.reason}`);

          // Emit status for UI
          console.log(`[Safety] statusEmitter available: ${!!statusEmitter}`);
          if (statusEmitter) {
            console.log(`[Safety] Emitting tool_blocked status`);
            statusEmitter({
              type: 'tool_blocked',
              toolName: input.tool_name,
              message: '🙀 whoa! not allowed!',
              blockedReason: validation.reason || 'Dangerous operation blocked',
            });
          } else {
            console.log(`[Safety] WARNING: No status emitter set!`);
          }

          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `🚫 Safety block: ${validation.reason}`,
            },
          };
        }

        console.log(`[Safety] HOOK ALLOWED: ${input.tool_name}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
          },
        };
      },
    ],
  };
}
