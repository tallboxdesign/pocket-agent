import { contextBridge, ipcRenderer } from 'electron';

// Expose API to renderer process
contextBridge.exposeInMainWorld('pocketAgent', {
  // Chat
  send: (message: string, sessionId?: string) => ipcRenderer.invoke('agent:send', message, sessionId),
  stop: (sessionId?: string) => ipcRenderer.invoke('agent:stop', sessionId),
  onStatus: (callback: (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { type: string; toolName?: string; toolInput?: string; message?: string }) => callback(status);
    ipcRenderer.on('agent:status', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
  saveAttachment: (name: string, dataUrl: string) => ipcRenderer.invoke('attachment:save', name, dataUrl),
  onSchedulerMessage: (callback: (data: { jobName: string; prompt: string; response: string; sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { jobName: string; prompt: string; response: string; sessionId: string }) => callback(data);
    ipcRenderer.on('scheduler:message', listener);
    return () => ipcRenderer.removeListener('scheduler:message', listener);
  },
  onTelegramMessage: (callback: (data: { userMessage: string; response: string; chatId: number; sessionId: string; hasAttachment?: boolean; attachmentType?: 'photo' | 'voice' | 'audio' }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { userMessage: string; response: string; chatId: number; sessionId: string; hasAttachment?: boolean; attachmentType?: 'photo' | 'voice' | 'audio' }) => callback(data);
    ipcRenderer.on('telegram:message', listener);
    return () => ipcRenderer.removeListener('telegram:message', listener);
  },
  getHistory: (limit?: number, sessionId?: string) => ipcRenderer.invoke('agent:history', limit, sessionId),
  getStats: (sessionId?: string) => ipcRenderer.invoke('agent:stats', sessionId),
  clearConversation: (sessionId?: string) => ipcRenderer.invoke('agent:clear', sessionId),

  // Sessions
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (name: string) => ipcRenderer.invoke('sessions:create', name),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),

  // Facts
  listFacts: () => ipcRenderer.invoke('facts:list'),
  searchFacts: (query: string) => ipcRenderer.invoke('facts:search', query),
  getFactCategories: () => ipcRenderer.invoke('facts:categories'),
  deleteFact: (id: number) => ipcRenderer.invoke('facts:delete', id),
  getGraphData: () => ipcRenderer.invoke('facts:graph-data'),

  // Soul (Self-Knowledge)
  listSoulAspects: () => ipcRenderer.invoke('soul:list'),
  getSoulAspect: (aspect: string) => ipcRenderer.invoke('soul:get', aspect),
  deleteSoulAspect: (id: number) => ipcRenderer.invoke('soul:delete', id),

  // App windows
  openFactsGraph: () => ipcRenderer.invoke('app:openFactsGraph'),
  openFacts: () => ipcRenderer.invoke('app:openFacts'),
  openSoul: () => ipcRenderer.invoke('app:openSoul'),
  openCustomize: () => ipcRenderer.invoke('app:openCustomize'),
  openRoutines: () => ipcRenderer.invoke('app:openRoutines'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  openPath: (filePath: string) => ipcRenderer.invoke('app:openPath', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('app:showInFolder', filePath),

  // Customize
  getIdentity: () => ipcRenderer.invoke('customize:getIdentity'),
  saveIdentity: (content: string) => ipcRenderer.invoke('customize:saveIdentity', content),
  getIdentityPath: () => ipcRenderer.invoke('customize:getIdentityPath'),
  getInstructions: () => ipcRenderer.invoke('customize:getInstructions'),
  saveInstructions: (content: string) => ipcRenderer.invoke('customize:saveInstructions', content),
  getInstructionsPath: () => ipcRenderer.invoke('customize:getInstructionsPath'),

  // Location and timezone
  lookupLocation: (query: string) => ipcRenderer.invoke('location:lookup', query),
  getTimezones: () => ipcRenderer.invoke('timezone:list'),

  // Cron
  getCronJobs: () => ipcRenderer.invoke('cron:list'),
  createCronJob: (name: string, schedule: string, prompt: string, channel: string, sessionId: string) =>
    ipcRenderer.invoke('cron:create', name, schedule, prompt, channel, sessionId),
  deleteCronJob: (name: string) => ipcRenderer.invoke('cron:delete', name),
  toggleCronJob: (name: string, enabled: boolean) => ipcRenderer.invoke('cron:toggle', name, enabled),
  runCronJob: (name: string) => ipcRenderer.invoke('cron:run', name),
  getCronHistory: (limit?: number) => ipcRenderer.invoke('cron:history', limit),

  // App info
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  deleteSetting: (key: string) => ipcRenderer.invoke('settings:delete', key),
  getSettingsSchema: (category?: string) => ipcRenderer.invoke('settings:schema', category),
  isFirstRun: () => ipcRenderer.invoke('settings:isFirstRun'),
  initializeKeychain: () => ipcRenderer.invoke('settings:initializeKeychain'),
  validateAnthropicKey: (key: string) => ipcRenderer.invoke('settings:validateAnthropic', key),
  validateOpenAIKey: (key: string) => ipcRenderer.invoke('settings:validateOpenAI', key),
  validateMoonshotKey: (key: string) => ipcRenderer.invoke('settings:validateMoonshot', key),
  validateTelegramToken: (token: string) => ipcRenderer.invoke('settings:validateTelegram', token),
  getAvailableModels: () => ipcRenderer.invoke('settings:getAvailableModels'),
  restartAgent: () => ipcRenderer.invoke('agent:restart'),
  glmHealthCheck: () => ipcRenderer.invoke('glm:healthCheck'),
  gogStatus: () => ipcRenderer.invoke('gog:status'),

  // Gmail Email Processing
  gmailFetchLabels: (account?: string) => ipcRenderer.invoke('gmail:fetchLabels', account),
  gmailFetchRecentEmails: (account?: string) => ipcRenderer.invoke('gmail:fetchRecentEmails', account),
  gmailGetEmailPreview: (messageId: string, account?: string) => ipcRenderer.invoke('gmail:getEmailPreview', messageId, account),
  gmailRunEmailProcessor: () => ipcRenderer.invoke('gmail:runEmailProcessor'),
  gmailGetProcessingStatus: () => ipcRenderer.invoke('gmail:getProcessingStatus'),
  gmailGetProcessedEmails: (limit?: number, offset?: number, filters?: { label?: string; since?: string; sender?: string }) => ipcRenderer.invoke('gmail:getProcessedEmails', limit, offset, filters),
  gmailCorrectLabel: (messageId: string, account: string, newLabel: string, useAsExample: boolean) =>
    ipcRenderer.invoke('gmail:correctLabel', messageId, account, newLabel, useAsExample),
  gmailGetLabelStats: (account?: string) => ipcRenderer.invoke('gmail:getLabelStats', account),

  // Rules Engine
  rulesGetAll: (account?: string) => ipcRenderer.invoke('rules:getAll', account),
  rulesGet: (id: number) => ipcRenderer.invoke('rules:get', id),
  rulesCreate: (rule: Record<string, unknown>) => ipcRenderer.invoke('rules:create', rule),
  rulesUpdate: (id: number, updates: Record<string, unknown>) => ipcRenderer.invoke('rules:update', id, updates),
  rulesDelete: (id: number) => ipcRenderer.invoke('rules:delete', id),
  rulesToggle: (id: number, enabled: boolean) => ipcRenderer.invoke('rules:toggle', id, enabled),
  rulesTest: (id: number, limit?: number) => ipcRenderer.invoke('rules:test', id, limit),
  rulesGetExecutions: (ruleId?: number, limit?: number) => ipcRenderer.invoke('rules:getExecutions', ruleId, limit),
  rulesRunDailySummary: () => ipcRenderer.invoke('rules:runDailySummary'),

  onEmailProgress: (callback: (data: { status: string; [key: string]: unknown }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { status: string; [key: string]: unknown }) => callback(data);
    ipcRenderer.on('gmail:progress', listener);
    return () => ipcRenderer.removeListener('gmail:progress', listener);
  },
  openSettings: (tab?: string) => ipcRenderer.invoke('app:openSettings', tab),
  openChat: () => ipcRenderer.invoke('app:openChat'),
  startOAuth: () => ipcRenderer.invoke('auth:startOAuth'),
  completeOAuth: (code: string) => ipcRenderer.invoke('auth:completeOAuth', code),
  cancelOAuth: () => ipcRenderer.invoke('auth:cancelOAuth'),
  isOAuthPending: () => ipcRenderer.invoke('auth:isOAuthPending'),

  // Skills
  getSkillsStatus: () => ipcRenderer.invoke('skills:getStatus'),
  installSkillDeps: (skillName: string) => ipcRenderer.invoke('skills:install', skillName),
  uninstallSkillDeps: (skillName: string) => ipcRenderer.invoke('skills:uninstall', skillName),
  openSkillsSetup: () => ipcRenderer.invoke('app:openSkillsSetup'),
  openPermissionSettings: (permissionType: string) => ipcRenderer.invoke('skills:openPermissionSettings', permissionType),
  checkPermission: (permissionType: string) => ipcRenderer.invoke('skills:checkPermission', permissionType),
  getSkillSetupConfig: (skillName: string) => ipcRenderer.invoke('skills:getSetupConfig', skillName),
  runSkillSetupCommand: (params: { skillName: string; stepId: string; inputs?: Record<string, string> }) =>
    ipcRenderer.invoke('skills:runSetupCommand', params),
  selectFile: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('skills:selectFile', options || {}),

  // Kanban
  openKanban: () => ipcRenderer.invoke('app:openKanban'),
  openEmailProcessing: () => ipcRenderer.invoke('app:openEmailProcessing'),
  kanbanListProjects: () => ipcRenderer.invoke('kanban:listProjects'),
  kanbanGetProject: (id: number) => ipcRenderer.invoke('kanban:getProject', id),
  kanbanCreateProject: (name: string, description?: string, color?: string) =>
    ipcRenderer.invoke('kanban:createProject', name, description, color),
  kanbanArchiveProject: (id: number) => ipcRenderer.invoke('kanban:archiveProject', id),
  kanbanDeleteProject: (id: number) => ipcRenderer.invoke('kanban:deleteProject', id),
  kanbanUpdateProject: (id: number, updates: Record<string, string>) =>
    ipcRenderer.invoke('kanban:updateProject', id, updates),
  kanbanGetBoard: (projectId: number) => ipcRenderer.invoke('kanban:getBoard', projectId),
  kanbanCreateTask: (input: Record<string, unknown>) => ipcRenderer.invoke('kanban:createTask', input),
  kanbanGetTask: (id: number) => ipcRenderer.invoke('kanban:getTask', id),
  kanbanUpdateTask: (id: number, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('kanban:updateTask', id, updates),
  kanbanMoveTask: (id: number, status: string) => ipcRenderer.invoke('kanban:moveTask', id, status),
  kanbanMoveTaskToProject: (id: number, projectId: number) =>
    ipcRenderer.invoke('kanban:moveTaskToProject', id, projectId),
  kanbanGetAllTasks: (statusFilter?: string[]) =>
    ipcRenderer.invoke('kanban:getAllTasks', statusFilter),
  kanbanDeleteTask: (id: number) => ipcRenderer.invoke('kanban:deleteTask', id),
  kanbanAddComment: (taskId: number, comment: string) =>
    ipcRenderer.invoke('kanban:addComment', taskId, comment),
  kanbanGetActivity: (taskId: number, limit?: number) =>
    ipcRenderer.invoke('kanban:getActivity', taskId, limit),
  kanbanApproveTask: (id: number) => ipcRenderer.invoke('kanban:approveTask', id),
  kanbanRejectTask: (id: number, feedback: string) =>
    ipcRenderer.invoke('kanban:rejectTask', id, feedback),
  kanbanSearchTasks: (query: string, projectId?: number) =>
    ipcRenderer.invoke('kanban:searchTasks', query, projectId),
  kanbanAddAttachment: (taskId: number, attachment: Record<string, unknown>) =>
    ipcRenderer.invoke('kanban:addAttachment', taskId, attachment),
  kanbanGetAttachments: (taskId: number) =>
    ipcRenderer.invoke('kanban:getAttachments', taskId),
  kanbanDeleteAttachment: (id: number) =>
    ipcRenderer.invoke('kanban:deleteAttachment', id),
  kanbanSelectFileOrFolder: (options?: { title?: string; properties?: string[] }) =>
    ipcRenderer.invoke('kanban:selectFileOrFolder', options || {}),

  // Voice
  synthesizeTTS: (text: string) => ipcRenderer.invoke('voice:tts', text),
  requestMicPermission: () => ipcRenderer.invoke('voice:micPermission'),
  transcribeAudio: (audioData: ArrayBuffer) => ipcRenderer.invoke('voice:transcribe', audioData),
  onVoicePlay: (callback: (audioPath: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, audioPath: string) => callback(audioPath);
    ipcRenderer.on('voice:play', listener);
    return () => ipcRenderer.removeListener('voice:play', listener);
  },
  onVoiceTtsToggled: (callback: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled);
    ipcRenderer.on('voice:ttsToggled', listener);
    return () => ipcRenderer.removeListener('voice:ttsToggled', listener);
  },

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:getStatus'),
  onUpdateStatus: (callback: (status: { status: string; info?: unknown; progress?: { percent: number }; error?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { status: string; info?: unknown; progress?: { percent: number }; error?: string }) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },

  // Navigation
  onNavigateTab: (callback: (tab: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tab: string) => callback(tab);
    ipcRenderer.on('navigate-tab', listener);
    return () => ipcRenderer.removeListener('navigate-tab', listener);
  },
});

// Session type
interface Session {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  telegram_linked?: boolean;
  telegram_group_name?: string | null;
}

// Type declarations for renderer
declare global {
  interface Window {
    pocketAgent: {
      send: (message: string, sessionId?: string) => Promise<{ success: boolean; response?: string; error?: string; tokensUsed?: number; suggestedPrompt?: string }>;
      stop: (sessionId?: string) => Promise<{ success: boolean }>;
      onStatus: (callback: (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => void) => () => void;
      saveAttachment: (name: string, dataUrl: string) => Promise<string>;
      onSchedulerMessage: (callback: (data: { jobName: string; prompt: string; response: string; sessionId: string }) => void) => () => void;
      onTelegramMessage: (callback: (data: { userMessage: string; response: string; chatId: number; sessionId: string; hasAttachment?: boolean; attachmentType?: 'photo' | 'voice' | 'audio' }) => void) => () => void;
      getHistory: (limit?: number, sessionId?: string) => Promise<Array<{ role: string; content: string; timestamp: string; metadata?: { source?: string; jobName?: string } }>>;
      getStats: (sessionId?: string) => Promise<{ messageCount: number; factCount: number; estimatedTokens: number; sessionCount?: number } | null>;
      clearConversation: (sessionId?: string) => Promise<{ success: boolean }>;
      // Sessions
      getSessions: () => Promise<Session[]>;
      createSession: (name: string) => Promise<{ success: boolean; session?: Session; error?: string }>;
      renameSession: (id: string, name: string) => Promise<{ success: boolean; error?: string }>;
      deleteSession: (id: string) => Promise<{ success: boolean }>;
      listFacts: () => Promise<Array<{ id: number; category: string; subject: string; content: string }>>;
      searchFacts: (query: string) => Promise<Array<{ category: string; subject: string; content: string }>>;
      getFactCategories: () => Promise<string[]>;
      deleteFact: (id: number) => Promise<{ success: boolean }>;
      getGraphData: () => Promise<{
        nodes: Array<{ id: number; subject: string; category: string; content: string; group: number }>;
        links: Array<{ source: number; target: number; type: 'category' | 'semantic' | 'keyword'; strength: number }>;
      }>;
      // Soul
      listSoulAspects: () => Promise<Array<{ id: number; aspect: string; content: string; created_at: string; updated_at: string }>>;
      getSoulAspect: (aspect: string) => Promise<{ id: number; aspect: string; content: string; created_at: string; updated_at: string } | null>;
      deleteSoulAspect: (id: number) => Promise<{ success: boolean }>;
      // App windows
      openFactsGraph: () => Promise<void>;
      openFacts: () => Promise<void>;
      openSoul: () => Promise<void>;
      openCustomize: () => Promise<void>;
      openRoutines: () => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      openPath: (filePath: string) => Promise<void>;
      showInFolder: (filePath: string) => Promise<void>;
      // Customize
      getIdentity: () => Promise<string>;
      saveIdentity: (content: string) => Promise<{ success: boolean }>;
      getIdentityPath: () => Promise<string>;
      getInstructions: () => Promise<string>;
      saveInstructions: (content: string) => Promise<{ success: boolean }>;
      getInstructionsPath: () => Promise<string>;
      // Location and timezone
      lookupLocation: (query: string) => Promise<Array<{ city: string; country: string; province: string; timezone: string; display: string }>>;
      getTimezones: () => Promise<string[]>;
      getCronJobs: () => Promise<Array<{ id: number; name: string; schedule_type?: string; schedule: string | null; run_at?: string | null; interval_ms?: number | null; prompt: string; channel: string; enabled: boolean; session_id?: string | null; job_type?: 'routine' | 'reminder' }>>;
      createCronJob: (name: string, schedule: string, prompt: string, channel: string, sessionId: string) => Promise<{ success: boolean }>;
      deleteCronJob: (name: string) => Promise<{ success: boolean }>;
      toggleCronJob: (name: string, enabled: boolean) => Promise<{ success: boolean }>;
      runCronJob: (name: string) => Promise<{ jobName: string; response: string; success: boolean; error?: string } | null>;
      getCronHistory: (limit?: number) => Promise<Array<{ jobName: string; response: string; success: boolean; timestamp: string }>>;
      // App info
      getAppVersion: () => Promise<string>;
      // Settings
      getSettings: () => Promise<Record<string, string>>;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<{ success: boolean }>;
      deleteSetting: (key: string) => Promise<{ success: boolean }>;
      getSettingsSchema: (category?: string) => Promise<Array<{ key: string; defaultValue: string; encrypted: boolean; category: string; label: string; description?: string; type: string }>>;
      isFirstRun: () => Promise<boolean>;
      initializeKeychain: () => Promise<{ available: boolean; error?: string }>;
      validateAnthropicKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateOpenAIKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateMoonshotKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateTelegramToken: (token: string) => Promise<{ valid: boolean; error?: string; botInfo?: unknown }>;
      getAvailableModels: () => Promise<Array<{ id: string; name: string; provider: string }>>;
      restartAgent: () => Promise<{ success: boolean }>;
      glmHealthCheck: () => Promise<{ ok: boolean; models?: string[]; error?: string }>;
      gogStatus: () => Promise<{ ok: boolean; accounts?: string; error?: string }>;
      gmailFetchLabels: (account?: string) => Promise<{ success: boolean; labels?: string; error?: string }>;
      gmailFetchRecentEmails: (account?: string) => Promise<{ success: boolean; emails?: string; error?: string }>;
      gmailGetEmailPreview: (messageId: string, account?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
      gmailRunEmailProcessor: () => Promise<{ ok: boolean; error?: string }>;
      gmailGetProcessingStatus: () => Promise<{ runs: unknown[]; checkpoints: unknown[] }>;
      gmailGetProcessedEmails: (limit?: number, offset?: number, filters?: { label?: string; since?: string; sender?: string }) => Promise<{ emails: unknown[]; total: number }>;
      gmailCorrectLabel: (messageId: string, account: string, newLabel: string, useAsExample: boolean) => Promise<{ ok: boolean; error?: string }>;
      gmailGetLabelStats: (account?: string) => Promise<Array<{ label: string; count: number; lastUsed: string }>>;
      // Rules Engine
      rulesGetAll: (account?: string) => Promise<Array<Record<string, unknown>>>;
      rulesGet: (id: number) => Promise<Record<string, unknown> | null>;
      rulesCreate: (rule: Record<string, unknown>) => Promise<Record<string, unknown>>;
      rulesUpdate: (id: number, updates: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      rulesDelete: (id: number) => Promise<{ ok: boolean; error?: string }>;
      rulesToggle: (id: number, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      rulesTest: (id: number, limit?: number) => Promise<Array<{ email: { subject: string; sender: string; label: string }; matched: boolean; conditions: Array<{ type: string; value: string; passed: boolean }> }>>;
      rulesGetExecutions: (ruleId?: number, limit?: number) => Promise<Array<Record<string, unknown>>>;
      rulesRunDailySummary: () => Promise<{ success: boolean; summary?: string; error?: string }>;
      onEmailProgress: (callback: (data: { status: string; [key: string]: unknown }) => void) => () => void;
      openSettings: () => Promise<void>;
      openChat: () => Promise<void>;
      startOAuth: () => Promise<{ success: boolean; error?: string }>;
      completeOAuth: (code: string) => Promise<{ success: boolean; error?: string }>;
      cancelOAuth: () => Promise<{ success: boolean }>;
      isOAuthPending: () => Promise<boolean>;
      // Kanban
      openKanban: () => Promise<void>;
      openEmailProcessing: () => Promise<void>;
      kanbanListProjects: () => Promise<Array<Record<string, unknown>>>;
      kanbanGetProject: (id: number) => Promise<Record<string, unknown> | null>;
      kanbanCreateProject: (name: string, description?: string, color?: string) => Promise<{ success: boolean; project?: Record<string, unknown>; error?: string }>;
      kanbanArchiveProject: (id: number) => Promise<{ success: boolean }>;
      kanbanDeleteProject: (id: number) => Promise<{ success: boolean; error?: string }>;
      kanbanUpdateProject: (id: number, updates: Record<string, string>) => Promise<{ success: boolean; project?: Record<string, unknown>; error?: string }>;
      kanbanGetBoard: (projectId: number) => Promise<Record<string, unknown> | null>;
      kanbanCreateTask: (input: Record<string, unknown>) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
      kanbanGetTask: (id: number) => Promise<Record<string, unknown> | null>;
      kanbanUpdateTask: (id: number, updates: Record<string, unknown>) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
      kanbanMoveTask: (id: number, status: string) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
      kanbanMoveTaskToProject: (id: number, projectId: number) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
      kanbanGetAllTasks: (statusFilter?: string[]) => Promise<Array<Record<string, unknown>>>;
      kanbanDeleteTask: (id: number) => Promise<{ success: boolean }>;
      kanbanAddComment: (taskId: number, comment: string) => Promise<{ success: boolean; error?: string }>;
      kanbanGetActivity: (taskId: number, limit?: number) => Promise<Array<Record<string, unknown>>>;
      kanbanApproveTask: (id: number) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
      kanbanRejectTask: (id: number, feedback: string) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
      kanbanSearchTasks: (query: string, projectId?: number) => Promise<Array<Record<string, unknown>>>;
      kanbanAddAttachment: (taskId: number, attachment: Record<string, unknown>) => Promise<{ success: boolean; attachment?: Record<string, unknown>; error?: string }>;
      kanbanGetAttachments: (taskId: number) => Promise<Array<Record<string, unknown>>>;
      kanbanDeleteAttachment: (id: number) => Promise<{ success: boolean }>;
      kanbanSelectFileOrFolder: (options?: { title?: string; properties?: string[] }) => Promise<{ success: boolean; canceled?: boolean; filePath?: string }>;
      // Voice
      synthesizeTTS: (text: string) => Promise<{ success: boolean; audioPath?: string; error?: string }>;
      requestMicPermission: () => Promise<{ granted: boolean }>;
      transcribeAudio: (audioData: ArrayBuffer) => Promise<{ success: boolean; text?: string; error?: string }>;
      onVoicePlay: (callback: (audioPath: string) => void) => () => void;
      onVoiceTtsToggled: (callback: (enabled: boolean) => void) => () => void;
      // Skills
      getSkillsStatus: () => Promise<{
        skills: Array<{
          name: string;
          available: boolean;
          missingBins: string[];
          missingEnvVars: string[];
          requiredEnvVars: string[];
          missingPermissions: string[];
          requiredPermissions: string[];
          osCompatible: boolean;
          installOptions: Array<{ id: string; kind: string; label: string; bins?: string[] }>;
        }>;
        summary: { total: number; available: number; unavailable: number; incompatible: number };
        prerequisites: { brew: boolean; go: boolean; node: boolean; uv: boolean; git: boolean };
      }>;
      installSkillDeps: (skillName: string) => Promise<{ success: boolean; installed: string[]; failed: string[] }>;
      uninstallSkillDeps: (skillName: string) => Promise<{ success: boolean; removed: string[]; failed: string[] }>;
      openSkillsSetup: () => Promise<void>;
      openPermissionSettings: (permissionType: string) => Promise<void>;
      checkPermission: (permissionType: string) => Promise<{ type: string; granted: boolean; canRequest: boolean; label: string; description: string; settingsUrl: string }>;
      getSkillSetupConfig: (skillName: string) => Promise<{
        found: boolean;
        setup?: {
          type: string;
          title: string;
          steps: Array<{
            id: string;
            title: string;
            description: string;
            action: string;
            command?: string;
            inputs?: Array<{ id: string; label: string; placeholder?: string }>;
            file_type?: string;
            help_url?: string;
            verify?: boolean;
          }>;
        };
      }>;
      runSkillSetupCommand: (command: string) => Promise<{ success: boolean; output?: string; error?: string }>;
      // Updates
      checkForUpdates: () => Promise<{ status: string; info?: { version: string }; error?: string }>;
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
      installUpdate: () => Promise<{ success: boolean; error?: string }>;
      getUpdateStatus: () => Promise<{ status: string; info?: { version: string }; progress?: { percent: number }; error?: string }>;
      onUpdateStatus: (callback: (status: { status: string; info?: { version: string }; progress?: { percent: number }; error?: string }) => void) => () => void;
    };
  }
}
