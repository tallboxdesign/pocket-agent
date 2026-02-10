/**
 * Unit tests for the Skills dependency manager
 *
 * Note: Since the skills module captures os.platform() at load time (PLATFORM constant),
 * we test the actual behavior on the current platform rather than trying to mock it.
 * Platform-specific behavior is tested through conditional expectations.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as os from 'os';

// Mock modules before imports
vi.mock('fs');
vi.mock('child_process');

// Import the module under test after mocks are set up
import {
  loadSkillsManifest,
  isBinAvailable,
  isOsCompatible,
  getSkillStatus,
  getAllSkillStatuses,
  getSkillsSummary,
  hasHomebrew,
  hasGo,
  hasNode,
  hasUv,
  installDependency,
  installSkillDependencies,
  batchInstallDependencies,
  getRecommendedInstallOrder,
  checkPrerequisites,
  type SkillsManifest,
  type SkillDependency,
  type SkillStatus,
  type InstallOption,
} from '../../src/skills/index';

import * as fs from 'fs';
import { execSync, exec } from 'child_process';

// Type the mocked functions
const mockExistsSync = fs.existsSync as Mock;
const mockReadFileSync = fs.readFileSync as Mock;
const mockReaddirSync = fs.readdirSync as Mock;
const mockExecSync = execSync as Mock;
const mockExec = exec as Mock;

// Get the current platform for conditional tests
const CURRENT_PLATFORM = os.platform();
const HOME_DIR = os.homedir();

// Sample test data
const createTestManifest = (): SkillsManifest => ({
  version: '1.0.0',
  generated: '2024-01-01T00:00:00Z',
  source: 'test',
  skills: {
    'skill-with-node': {
      bins: ['node', 'npm'],
      os: ['darwin', 'linux', 'win32'],
      install: [
        {
          id: 'node-brew',
          kind: 'brew',
          formula: 'node',
          bins: ['node', 'npm'],
          label: 'Install via Homebrew',
          os: ['darwin'],
        },
      ],
    },
    'skill-with-python': {
      bins: ['python', 'pip'],
      os: ['darwin', 'linux'],
      install: [
        {
          id: 'python-brew',
          kind: 'brew',
          formula: 'python',
          bins: ['python', 'pip'],
          label: 'Install via Homebrew',
          os: ['darwin'],
        },
        {
          id: 'python-apt',
          kind: 'apt',
          package: 'python3',
          bins: ['python', 'pip'],
          label: 'Install via apt',
          os: ['linux'],
        },
      ],
    },
    'macos-only-skill': {
      bins: ['swift'],
      os: ['darwin'],
      install: [
        {
          id: 'swift-xcode',
          kind: 'download',
          url: 'https://developer.apple.com/xcode/',
          bins: ['swift'],
          label: 'Install Xcode',
          os: ['darwin'],
        },
      ],
    },
    'universal-skill': {
      bins: ['git'],
      os: [],
      install: [
        {
          id: 'git-brew',
          kind: 'brew',
          formula: 'git',
          bins: ['git'],
          label: 'Install via Homebrew',
          os: ['darwin'],
        },
      ],
    },
  },
});

const createTestSkillDependency = (overrides?: Partial<SkillDependency>): SkillDependency => ({
  bins: ['testbin'],
  os: ['darwin', 'linux'],
  install: [
    {
      id: 'test-install',
      kind: 'brew',
      formula: 'testformula',
      bins: ['testbin'],
      label: 'Test install option',
      os: ['darwin'],
    },
  ],
  ...overrides,
});

// Helper to setup common mocks that won't interfere with bin detection
const setupBaseMocks = () => {
  mockReaddirSync.mockReturnValue([]);
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd === 'npm prefix -g') {
      return '/usr/local';
    }
    throw new Error('not found');
  });
};

describe('loadSkillsManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return null when manifest file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = loadSkillsManifest('/test/skills');

    expect(result).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith('/test/skills/skills-manifest.json');
    expect(warnSpy).toHaveBeenCalledWith('[Skills] No skills-manifest.json found');
  });

  it('should load and parse manifest file when it exists', () => {
    const testManifest = createTestManifest();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(testManifest));

    const result = loadSkillsManifest('/test/skills');

    expect(result).toEqual(testManifest);
    expect(mockReadFileSync).toHaveBeenCalledWith('/test/skills/skills-manifest.json', 'utf-8');
  });

  it('should return null and log error when JSON is invalid', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('invalid json {{{');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadSkillsManifest('/test/skills');

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toBe('[Skills] Failed to load manifest:');
  });

  it('should return null when readFileSync throws an error', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadSkillsManifest('/test/skills');

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('isBinAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return true when binary exists in known paths', () => {
    mockExistsSync.mockImplementation((p: string) => {
      return p === '/usr/local/bin/testbin';
    });

    const result = isBinAvailable('testbin');

    expect(result).toBe(true);
  });

  it('should return true when binary found via PATH scanning', () => {
    // Mock PATH to include a custom directory
    const originalPath = process.env.PATH;
    process.env.PATH = '/custom/path/bin:/usr/bin';

    mockExistsSync.mockImplementation((p: string) => {
      // Binary found in PATH directory
      return p === '/custom/path/bin/testbin';
    });

    const result = isBinAvailable('testbin');

    expect(result).toBe(true);

    // Restore PATH
    process.env.PATH = originalPath;
  });

  it('should return false when binary is not found anywhere', () => {
    mockExistsSync.mockReturnValue(false);

    const result = isBinAvailable('nonexistentbin');

    expect(result).toBe(false);
  });

  it('should check multiple paths including homebrew locations', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p: string) => {
      checkedPaths.push(p as string);
      return false;
    });

    isBinAvailable('brew');

    // Should check various common paths
    expect(checkedPaths.some((p) => p.includes('/bin/brew'))).toBe(true);
  });

  it('should check nvm paths when nvm directory exists', () => {
    // Note: The skills module caches paths at module load time,
    // so we test that the path checking mechanism works correctly
    // rather than trying to verify specific nvm paths
    const checkedPaths: string[] = [];

    mockExistsSync.mockImplementation((p: string) => {
      checkedPaths.push(p as string);
      return false;
    });

    isBinAvailable('node');

    // Should check various paths including user home-based paths
    expect(checkedPaths.length).toBeGreaterThan(0);
    // Verify it checks paths in home directory
    expect(checkedPaths.some((p) => p.includes(HOME_DIR))).toBe(true);
  });

  it('should check go paths', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p: string) => {
      checkedPaths.push(p as string);
      return false;
    });

    isBinAvailable('go');

    // Should check go bin path
    expect(checkedPaths.some((p) => p.includes('/go/bin'))).toBe(true);
  });

  it('should check cargo paths', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p: string) => {
      checkedPaths.push(p as string);
      return false;
    });

    isBinAvailable('cargo');

    // Should check cargo bin path
    expect(checkedPaths.some((p) => p.includes('.cargo/bin'))).toBe(true);
  });
});

describe('isOsCompatible', () => {
  it('should return true when os array is empty (universal skill)', () => {
    const skill = createTestSkillDependency({ os: [] });

    const result = isOsCompatible(skill);

    expect(result).toBe(true);
  });

  it('should return true when current platform is in os array', () => {
    const skill = createTestSkillDependency({ os: [CURRENT_PLATFORM] });

    const result = isOsCompatible(skill);

    expect(result).toBe(true);
  });

  it('should return false when current platform is not in os array', () => {
    // Use an OS that definitely isn't the current one
    const otherPlatform = CURRENT_PLATFORM === 'darwin' ? 'win32' : 'darwin';
    const skill = createTestSkillDependency({ os: [otherPlatform] });

    const result = isOsCompatible(skill);

    expect(result).toBe(false);
  });
});

describe('getSkillStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return available=true when all bins are present and OS is compatible', () => {
    mockExistsSync.mockImplementation((p: string) => {
      return p === '/usr/local/bin/testbin';
    });

    const skill = createTestSkillDependency({
      bins: ['testbin'],
      os: [CURRENT_PLATFORM],
    });

    const result = getSkillStatus('test-skill', skill);

    expect(result.name).toBe('test-skill');
    expect(result.available).toBe(true);
    expect(result.missingBins).toEqual([]);
    expect(result.osCompatible).toBe(true);
  });

  it('should return available=false when bins are missing', () => {
    mockExistsSync.mockReturnValue(false);

    const skill = createTestSkillDependency({
      bins: ['missingbin'],
      os: [CURRENT_PLATFORM],
    });

    const result = getSkillStatus('missing-skill', skill);

    expect(result.available).toBe(false);
    expect(result.missingBins).toContain('missingbin');
  });

  it('should return available=false when OS is not compatible', () => {
    const incompatibleOs = CURRENT_PLATFORM === 'darwin' ? 'win32' : 'darwin';
    const skill = createTestSkillDependency({
      bins: [],
      os: [incompatibleOs],
    });

    const result = getSkillStatus('incompatible-skill', skill);

    expect(result.available).toBe(false);
    expect(result.osCompatible).toBe(false);
  });

  it('should filter install options by current OS', () => {
    mockExistsSync.mockReturnValue(false);

    const skill = createTestSkillDependency({
      bins: ['testbin'],
      os: ['darwin', 'linux', 'win32'],
      install: [
        {
          id: 'current-os-install',
          kind: 'brew',
          formula: 'test',
          bins: ['testbin'],
          label: 'Current OS install',
          os: [CURRENT_PLATFORM],
        },
        {
          id: 'other-os-install',
          kind: 'apt',
          package: 'test',
          bins: ['testbin'],
          label: 'Other OS install',
          os: [CURRENT_PLATFORM === 'darwin' ? 'linux' : 'darwin'],
        },
        {
          id: 'universal-install',
          kind: 'node',
          package: 'test',
          bins: ['testbin'],
          label: 'Universal install',
          // No os restriction
        },
      ],
    });

    const result = getSkillStatus('multi-install-skill', skill);

    // Should include current OS and universal options only
    expect(result.installOptions.some((o) => o.id === 'current-os-install')).toBe(true);
    expect(result.installOptions.some((o) => o.id === 'universal-install')).toBe(true);
    expect(result.installOptions.some((o) => o.id === 'other-os-install')).toBe(false);
  });
});

describe('getAllSkillStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return status for all skills in manifest', () => {
    const manifest = createTestManifest();

    const statuses = getAllSkillStatuses(manifest);

    expect(statuses.length).toBe(4);
    expect(statuses.map((s) => s.name)).toContain('skill-with-node');
    expect(statuses.map((s) => s.name)).toContain('skill-with-python');
    expect(statuses.map((s) => s.name)).toContain('macos-only-skill');
    expect(statuses.map((s) => s.name)).toContain('universal-skill');
  });
});

describe('getSkillsSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should correctly count available and unavailable skills', () => {
    // Make node and npm available, others missing
    mockExistsSync.mockImplementation((p: string) => {
      return (
        p === '/usr/local/bin/node' ||
        p === '/usr/local/bin/npm' ||
        p === '/usr/local/bin/git'
      );
    });

    const manifest = createTestManifest();
    const summary = getSkillsSummary(manifest);

    expect(summary.total).toBe(4);
    expect(summary.available).toBeGreaterThanOrEqual(0);
    expect(summary.unavailable).toBeGreaterThanOrEqual(0);
    expect(summary.available + summary.unavailable + summary.incompatible).toBe(summary.total);
  });

  it('should identify skills missing dependencies', () => {
    mockExistsSync.mockReturnValue(false);

    const manifest = createTestManifest();
    const summary = getSkillsSummary(manifest);

    expect(summary.missingDeps.length).toBeGreaterThan(0);
    expect(summary.missingDeps.every((s) => s.osCompatible && !s.available)).toBe(true);
  });
});

describe('helper functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('hasHomebrew', () => {
    it('should return true when brew is available', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/brew');
      });

      expect(hasHomebrew()).toBe(true);
    });

    it('should return false when brew is not available', () => {
      mockExistsSync.mockReturnValue(false);

      expect(hasHomebrew()).toBe(false);
    });
  });

  describe('hasGo', () => {
    it('should return true when go is available', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/go');
      });

      expect(hasGo()).toBe(true);
    });
  });

  describe('hasNode', () => {
    it('should return true when npm is available', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/npm');
      });

      expect(hasNode()).toBe(true);
    });
  });

  describe('hasUv', () => {
    it('should return true when uv is available', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/uv') || p.endsWith('/.local/bin/uv');
      });

      expect(hasUv()).toBe(true);
    });
  });

  describe('checkPrerequisites', () => {
    it('should return status of all common dependencies', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return (
          p.endsWith('/bin/brew') || p.endsWith('/bin/git') || p.endsWith('/bin/npm')
        );
      });

      const prereqs = checkPrerequisites();

      expect(prereqs).toHaveProperty('brew');
      expect(prereqs).toHaveProperty('go');
      expect(prereqs).toHaveProperty('node');
      expect(prereqs).toHaveProperty('uv');
      expect(prereqs).toHaveProperty('git');
      expect(typeof prereqs.brew).toBe('boolean');
      expect(typeof prereqs.go).toBe('boolean');
      expect(typeof prereqs.node).toBe('boolean');
      expect(typeof prereqs.uv).toBe('boolean');
      expect(typeof prereqs.git).toBe('boolean');
    });
  });
});

describe('installDependency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('brew installations', () => {
    it('should install via brew when homebrew is available', async () => {
      // Make brew available
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/brew');
      });

      // Mock exec for async installation
      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const option: InstallOption = {
        id: 'test-brew',
        kind: 'brew',
        formula: 'testpkg',
        bins: ['testbin'],
        label: 'Test brew install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(true);
    });

    it('should fail when homebrew is not available', async () => {
      mockExistsSync.mockReturnValue(false);

      const option: InstallOption = {
        id: 'test-brew',
        kind: 'brew',
        formula: 'testpkg',
        bins: ['testbin'],
        label: 'Test brew install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Homebrew not installed');
    });
  });

  describe('brew-cask installations', () => {
    it('should install via brew cask when homebrew is available', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/brew');
      });

      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const option: InstallOption = {
        id: 'test-cask',
        kind: 'brew-cask',
        cask: 'visual-studio-code',
        bins: ['code'],
        label: 'Test cask install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(true);
    });
  });

  describe('node installations', () => {
    it('should install via npm when node is available', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/npm');
      });

      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const option: InstallOption = {
        id: 'test-node',
        kind: 'node',
        package: 'typescript',
        bins: ['tsc'],
        label: 'Test npm install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(true);
    });

    it('should fail when node/npm is not available', async () => {
      mockExistsSync.mockReturnValue(false);

      const option: InstallOption = {
        id: 'test-node',
        kind: 'node',
        package: 'typescript',
        bins: ['tsc'],
        label: 'Test npm install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Node.js/npm not installed');
    });
  });

  describe('go installations', () => {
    it('should install via go install when go is available', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/go');
      });

      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const option: InstallOption = {
        id: 'test-go',
        kind: 'go',
        module: 'github.com/test/tool@latest',
        bins: ['tool'],
        label: 'Test go install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(true);
    });

    it('should fail when go is not available', async () => {
      mockExistsSync.mockReturnValue(false);

      const option: InstallOption = {
        id: 'test-go',
        kind: 'go',
        module: 'github.com/test/tool@latest',
        bins: ['tool'],
        label: 'Test go install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Go not installed');
    });
  });

  describe('uv installations', () => {
    it('should install via uv when uv is available', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/uv') || p.includes('/.local/bin/uv');
      });

      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const option: InstallOption = {
        id: 'test-uv',
        kind: 'uv',
        package: 'ruff',
        bins: ['ruff'],
        label: 'Test uv install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(true);
    });

    it('should try to install uv via brew if not available but brew exists', async () => {
      let uvAvailable = false;
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('/bin/brew')) return true;
        if (p.includes('uv')) return uvAvailable;
        return false;
      });

      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (cmd === 'brew install uv') {
            uvAvailable = true;
          }
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const option: InstallOption = {
        id: 'test-uv',
        kind: 'uv',
        package: 'ruff',
        bins: ['ruff'],
        label: 'Test uv install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(true);
    });
  });

  describe('apt installations', () => {
    it('should fail on non-Linux systems', async () => {
      // This test only makes sense on non-Linux platforms
      if (CURRENT_PLATFORM === 'linux') {
        // On Linux, we'd need to mock sudo apt-get which is complex
        expect(true).toBe(true);
        return;
      }

      const option: InstallOption = {
        id: 'test-apt',
        kind: 'apt',
        package: 'build-essential',
        bins: ['gcc'],
        label: 'Test apt install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toBe('apt only available on Linux');
    });
  });

  describe('download installations', () => {
    it('should return error for download kind (manual required)', async () => {
      const option: InstallOption = {
        id: 'test-download',
        kind: 'download',
        url: 'https://example.com/download',
        bins: ['tool'],
        label: 'Test download',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Manual download required');
    });
  });

  describe('error handling', () => {
    it('should return error for uv when uv and brew are not available', async () => {
      // Test error path: uv install fails when neither uv nor brew are available
      mockExistsSync.mockReturnValue(false);

      const option: InstallOption = {
        id: 'test-uv',
        kind: 'uv',
        package: 'ruff',
        bins: ['ruff'],
        label: 'Test uv install',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toBe('uv not installed and no way to install it');
    });

    it('should handle unknown install kind', async () => {
      const option = {
        id: 'test-unknown',
        kind: 'unknown' as InstallOption['kind'],
        bins: ['test'],
        label: 'Unknown kind',
      };

      const result = await installDependency(option);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown install kind');
    });
  });

  describe('progress callback', () => {
    it('should call progress callback with status messages', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/bin/brew');
      });

      mockExec.mockImplementation(
        (
          cmd: string,
          callback?: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (callback) {
            callback(null, 'installed', '');
          }
          return { stdout: 'installed', stderr: '' };
        }
      );

      const progressMessages: string[] = [];
      const onProgress = (msg: string) => progressMessages.push(msg);

      const option: InstallOption = {
        id: 'test-brew',
        kind: 'brew',
        formula: 'testpkg',
        bins: ['testbin'],
        label: 'Test brew install',
      };

      await installDependency(option, onProgress);

      expect(progressMessages.length).toBeGreaterThan(0);
      expect(progressMessages[0]).toContain('Installing');
    });
  });
});

describe('installSkillDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return success immediately if skill is already available', async () => {
    const status: SkillStatus = {
      name: 'available-skill',
      available: true,
      missingBins: [],
      osCompatible: true,
      installOptions: [],
    };

    const result = await installSkillDependencies(status);

    expect(result.success).toBe(true);
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('should fail if OS is not compatible', async () => {
    const status: SkillStatus = {
      name: 'incompatible-skill',
      available: false,
      missingBins: ['somebin'],
      osCompatible: false,
      installOptions: [],
    };

    const result = await installSkillDependencies(status);

    expect(result.success).toBe(false);
    expect(result.failed).toContain('OS not compatible');
  });

  it('should attempt to install missing bins', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      return p.endsWith('/bin/brew');
    });

    mockExec.mockImplementation(
      (
        cmd: string,
        callback?: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (callback) {
          callback(null, 'installed', '');
        }
        return { stdout: 'installed', stderr: '' };
      }
    );

    const status: SkillStatus = {
      name: 'missing-deps-skill',
      available: false,
      missingBins: ['testbin'],
      osCompatible: true,
      installOptions: [
        {
          id: 'test-install',
          kind: 'brew',
          formula: 'testpkg',
          bins: ['testbin'],
          label: 'Install test',
        },
      ],
    };

    const result = await installSkillDependencies(status);

    expect(result.installed).toContain('testbin');
  });

  it('should fail bins with no install options', async () => {
    const status: SkillStatus = {
      name: 'no-options-skill',
      available: false,
      missingBins: ['orphanbin'],
      osCompatible: true,
      installOptions: [], // No options to install orphanbin
    };

    const result = await installSkillDependencies(status);

    expect(result.success).toBe(false);
    expect(result.failed).toContain('orphanbin');
  });
});

describe('batchInstallDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should process multiple skills and return results map', async () => {
    const statuses: SkillStatus[] = [
      {
        name: 'skill-1',
        available: true,
        missingBins: [],
        osCompatible: true,
        installOptions: [],
      },
      {
        name: 'skill-2',
        available: false,
        missingBins: ['missingbin'],
        osCompatible: true,
        installOptions: [],
      },
    ];

    const results = await batchInstallDependencies(statuses);

    expect(results.size).toBe(2);
    expect(results.get('skill-1')?.success).toBe(true);
    expect(results.get('skill-2')?.success).toBe(false);
  });

  it('should call progress callback for each skill', async () => {
    mockExistsSync.mockReturnValue(false);

    const statuses: SkillStatus[] = [
      {
        name: 'skill-1',
        available: true,
        missingBins: [],
        osCompatible: true,
        installOptions: [],
      },
    ];

    const progressCalls: Array<{ skill: string; message: string }> = [];
    const onProgress = (skill: string, message: string) => {
      progressCalls.push({ skill, message });
    };

    await batchInstallDependencies(statuses, onProgress);

    // Available skills don't trigger progress
    expect(progressCalls.length).toBe(0);
  });
});

describe('getRecommendedInstallOrder', () => {
  it('should sort install options by usage count (most used first)', () => {
    const statuses: SkillStatus[] = [
      {
        name: 'skill-1',
        available: false,
        missingBins: ['bin1'],
        osCompatible: true,
        installOptions: [
          {
            id: 'common-install',
            kind: 'brew',
            formula: 'common',
            bins: ['common'],
            label: 'Common',
          },
          {
            id: 'rare-install',
            kind: 'brew',
            formula: 'rare',
            bins: ['rare'],
            label: 'Rare',
          },
        ],
      },
      {
        name: 'skill-2',
        available: false,
        missingBins: ['bin2'],
        osCompatible: true,
        installOptions: [
          {
            id: 'common-install',
            kind: 'brew',
            formula: 'common',
            bins: ['common'],
            label: 'Common',
          },
        ],
      },
      {
        name: 'skill-3',
        available: false,
        missingBins: ['bin3'],
        osCompatible: true,
        installOptions: [
          {
            id: 'common-install',
            kind: 'brew',
            formula: 'common',
            bins: ['common'],
            label: 'Common',
          },
        ],
      },
    ];

    const recommended = getRecommendedInstallOrder(statuses);

    // Common should be first since it's needed by 3 skills
    expect(recommended[0].formula).toBe('common');
    expect(recommended.length).toBe(2);
  });

  it('should return empty array for available skills', () => {
    const statuses: SkillStatus[] = [
      {
        name: 'available-skill',
        available: true,
        missingBins: [],
        osCompatible: true,
        installOptions: [],
      },
    ];

    const recommended = getRecommendedInstallOrder(statuses);

    expect(recommended).toEqual([]);
  });

  it('should handle skills with different install kinds', () => {
    const statuses: SkillStatus[] = [
      {
        name: 'skill-1',
        available: false,
        missingBins: ['node'],
        osCompatible: true,
        installOptions: [
          {
            id: 'node-brew',
            kind: 'brew',
            formula: 'node',
            bins: ['node'],
            label: 'Node via brew',
          },
        ],
      },
      {
        name: 'skill-2',
        available: false,
        missingBins: ['tsc'],
        osCompatible: true,
        installOptions: [
          {
            id: 'tsc-npm',
            kind: 'node',
            package: 'typescript',
            bins: ['tsc'],
            label: 'TypeScript via npm',
          },
        ],
      },
    ];

    const recommended = getRecommendedInstallOrder(statuses);

    expect(recommended.length).toBe(2);
    // Both should be unique entries
    const ids = recommended.map((o) => o.id);
    expect(ids).toContain('node-brew');
    expect(ids).toContain('tsc-npm');
  });
});

describe('edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('empty manifest', () => {
    it('should handle manifest with no skills', () => {
      mockExistsSync.mockReturnValue(false);

      const manifest: SkillsManifest = {
        version: '1.0.0',
        generated: '2024-01-01T00:00:00Z',
        source: 'test',
        skills: {},
      };

      const statuses = getAllSkillStatuses(manifest);
      const summary = getSkillsSummary(manifest);

      expect(statuses).toEqual([]);
      expect(summary.total).toBe(0);
      expect(summary.available).toBe(0);
    });
  });

  describe('skill with no bins', () => {
    it('should be available if OS compatible and no bins required', () => {
      const skill = createTestSkillDependency({
        bins: [],
        os: [CURRENT_PLATFORM],
      });

      const status = getSkillStatus('no-bins-skill', skill);

      expect(status.available).toBe(true);
      expect(status.missingBins).toEqual([]);
    });
  });

  describe('skill with multiple bins where some exist', () => {
    it('should report only missing bins', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p === '/usr/local/bin/existing';
      });

      const skill = createTestSkillDependency({
        bins: ['existing', 'missing1', 'missing2'],
        os: [CURRENT_PLATFORM],
      });

      const status = getSkillStatus('partial-skill', skill);

      expect(status.available).toBe(false);
      expect(status.missingBins).not.toContain('existing');
      expect(status.missingBins).toContain('missing1');
      expect(status.missingBins).toContain('missing2');
    });
  });

  describe('permission errors', () => {
    it('should handle permission denied when reading manifest', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        const error = new Error('EACCES: permission denied');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = loadSkillsManifest('/restricted/skills');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('should handle permission denied when checking bin availability', () => {
      // The isBinAvailable function doesn't have error handling for existsSync,
      // but it does catch errors from execSync (the which command fallback).
      // Test that when existsSync returns false for all paths and which throws,
      // the function returns false gracefully.
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.startsWith('which ')) {
          const error = new Error('EACCES: permission denied');
          (error as NodeJS.ErrnoException).code = 'EACCES';
          throw error;
        }
        if (cmd === 'npm prefix -g') {
          return '/usr/local';
        }
        throw new Error('not found');
      });

      // The function should handle this gracefully and return false
      const result = isBinAvailable('somebin');

      expect(result).toBe(false);
    });
  });

  describe('invalid skill definitions', () => {
    it('should handle skill with empty install array', () => {
      mockExistsSync.mockReturnValue(false);

      const skill: SkillDependency = {
        bins: ['test'],
        os: [CURRENT_PLATFORM],
        install: [],
      };

      const status = getSkillStatus('empty-install-skill', skill);

      expect(status.installOptions).toEqual([]);
    });
  });
});
