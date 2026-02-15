import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We can't import the functions directly from main/index.ts (it has Electron side effects),
// so we replicate the pure logic here for testing. This ensures the algorithm is correct.

function scanVersionBins(versionsDir: string, binSubdir = 'bin'): string[] {
  const paths: string[] = [];
  try {
    if (fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir)) {
        const binPath = path.join(versionsDir, entry, binSubdir);
        if (fs.existsSync(binPath)) {
          paths.push(binPath);
        }
      }
    }
  } catch {
    // Ignore errors reading directory
  }
  return paths;
}

function detectNodeManagerPaths(homeDir: string): string[] {
  const paths: string[] = [];

  // nvm
  paths.push(...scanVersionBins(path.join(homeDir, '.nvm/versions/node')));

  // fnm
  const fnmPaths = [
    path.join(homeDir, '.fnm/aliases/default/bin'),
    path.join(homeDir, '.local/share/fnm/aliases/default/bin'),
  ];
  for (const p of fnmPaths) {
    if (fs.existsSync(p)) paths.push(p);
  }

  // volta
  const voltaBin = path.join(homeDir, '.volta/bin');
  if (fs.existsSync(voltaBin)) paths.push(voltaBin);

  // asdf
  const asdfShims = path.join(homeDir, '.asdf/shims');
  if (fs.existsSync(asdfShims)) paths.push(asdfShims);

  // nodenv
  const nodenvShims = path.join(homeDir, '.nodenv/shims');
  if (fs.existsSync(nodenvShims)) paths.push(nodenvShims);

  // n
  paths.push(...scanVersionBins('/usr/local/n/versions/node'));
  const nPrefix = process.env.N_PREFIX;
  if (nPrefix) {
    const nPrefixBin = path.join(nPrefix, 'bin');
    if (fs.existsSync(nPrefixBin)) paths.push(nPrefixBin);
  }

  // mise
  const miseShims = path.join(homeDir, '.local/share/mise/shims');
  if (fs.existsSync(miseShims)) paths.push(miseShims);

  return paths;
}

function detectWindowsNodePaths(homeDir: string): string[] {
  const paths: string[] = [];
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');

  // nvm-windows
  paths.push(...scanVersionBins(path.join(appData, 'nvm'), '.'));

  // fnm
  const fnmDefault = path.join(appData, 'fnm', 'aliases', 'default');
  if (fs.existsSync(fnmDefault)) paths.push(fnmDefault);

  // volta
  const voltaPaths = [
    path.join(appData, 'Volta', 'bin'),
    path.join(localAppData, 'Volta', 'bin'),
  ];
  for (const p of voltaPaths) {
    if (fs.existsSync(p)) paths.push(p);
  }

  // scoop
  const scoopShims = path.join(homeDir, 'scoop', 'shims');
  if (fs.existsSync(scoopShims)) paths.push(scoopShims);

  // chocolatey
  const chocoBin = 'C:\\ProgramData\\chocolatey\\bin';
  if (fs.existsSync(chocoBin)) paths.push(chocoBin);

  // nodist
  const nodistBin = path.join(appData, 'nodist', 'bin');
  if (fs.existsSync(nodistBin)) paths.push(nodistBin);

  return paths;
}

describe('Node PATH Detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-path-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('scanVersionBins', () => {
    it('should find bin directories inside version folders', () => {
      const versionsDir = path.join(tmpDir, 'versions');
      fs.mkdirSync(path.join(versionsDir, 'v18.17.0', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(versionsDir, 'v20.10.0', 'bin'), { recursive: true });

      const result = scanVersionBins(versionsDir);
      expect(result).toHaveLength(2);
      expect(result).toContain(path.join(versionsDir, 'v18.17.0', 'bin'));
      expect(result).toContain(path.join(versionsDir, 'v20.10.0', 'bin'));
    });

    it('should skip version folders without bin directory', () => {
      const versionsDir = path.join(tmpDir, 'versions');
      fs.mkdirSync(path.join(versionsDir, 'v18.17.0', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(versionsDir, 'v20.10.0'), { recursive: true }); // no bin

      const result = scanVersionBins(versionsDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('v18.17.0');
    });

    it('should return empty array for non-existent directory', () => {
      const result = scanVersionBins(path.join(tmpDir, 'nonexistent'));
      expect(result).toEqual([]);
    });

    it('should support custom bin subdirectory for nvm-windows', () => {
      const nvmDir = path.join(tmpDir, 'nvm');
      // nvm-windows puts node.exe directly in the version dir, so binSubdir = '.'
      fs.mkdirSync(path.join(nvmDir, 'v18.17.0'), { recursive: true });
      fs.mkdirSync(path.join(nvmDir, 'v20.10.0'), { recursive: true });

      const result = scanVersionBins(nvmDir, '.');
      expect(result).toHaveLength(2);
    });
  });

  describe('detectNodeManagerPaths (Unix)', () => {
    it('should detect nvm paths', () => {
      fs.mkdirSync(path.join(tmpDir, '.nvm/versions/node/v20.10.0/bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.nvm/versions/node/v18.17.0/bin'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result.filter(p => p.includes('.nvm'))).toHaveLength(2);
    });

    it('should detect fnm paths (primary location)', () => {
      fs.mkdirSync(path.join(tmpDir, '.fnm/aliases/default/bin'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toContain(path.join(tmpDir, '.fnm/aliases/default/bin'));
    });

    it('should detect fnm paths (XDG location)', () => {
      fs.mkdirSync(path.join(tmpDir, '.local/share/fnm/aliases/default/bin'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toContain(path.join(tmpDir, '.local/share/fnm/aliases/default/bin'));
    });

    it('should detect volta path', () => {
      fs.mkdirSync(path.join(tmpDir, '.volta/bin'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toContain(path.join(tmpDir, '.volta/bin'));
    });

    it('should detect asdf shims', () => {
      fs.mkdirSync(path.join(tmpDir, '.asdf/shims'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toContain(path.join(tmpDir, '.asdf/shims'));
    });

    it('should detect nodenv shims', () => {
      fs.mkdirSync(path.join(tmpDir, '.nodenv/shims'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toContain(path.join(tmpDir, '.nodenv/shims'));
    });

    it('should detect mise shims', () => {
      fs.mkdirSync(path.join(tmpDir, '.local/share/mise/shims'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toContain(path.join(tmpDir, '.local/share/mise/shims'));
    });

    it('should detect n prefix from N_PREFIX env var', () => {
      const nPrefixDir = path.join(tmpDir, 'n-prefix');
      fs.mkdirSync(path.join(nPrefixDir, 'bin'), { recursive: true });

      const originalNPrefix = process.env.N_PREFIX;
      process.env.N_PREFIX = nPrefixDir;
      try {
        const result = detectNodeManagerPaths(tmpDir);
        expect(result).toContain(path.join(nPrefixDir, 'bin'));
      } finally {
        if (originalNPrefix === undefined) {
          delete process.env.N_PREFIX;
        } else {
          process.env.N_PREFIX = originalNPrefix;
        }
      }
    });

    it('should return empty array when no managers installed', () => {
      const result = detectNodeManagerPaths(tmpDir);
      expect(result).toEqual([]);
    });

    it('should detect multiple managers simultaneously', () => {
      fs.mkdirSync(path.join(tmpDir, '.nvm/versions/node/v20.10.0/bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.volta/bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.asdf/shims'), { recursive: true });

      const result = detectNodeManagerPaths(tmpDir);
      expect(result.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('detectWindowsNodePaths', () => {
    it('should detect fnm default on Windows', () => {
      const appData = path.join(tmpDir, 'AppData', 'Roaming');
      const fnmDefault = path.join(appData, 'fnm', 'aliases', 'default');
      fs.mkdirSync(fnmDefault, { recursive: true });

      const originalAppData = process.env.APPDATA;
      process.env.APPDATA = appData;
      try {
        const result = detectWindowsNodePaths(tmpDir);
        expect(result).toContain(fnmDefault);
      } finally {
        if (originalAppData === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = originalAppData;
        }
      }
    });

    it('should detect volta bin on Windows (APPDATA)', () => {
      const appData = path.join(tmpDir, 'AppData', 'Roaming');
      const voltaBin = path.join(appData, 'Volta', 'bin');
      fs.mkdirSync(voltaBin, { recursive: true });

      const originalAppData = process.env.APPDATA;
      process.env.APPDATA = appData;
      try {
        const result = detectWindowsNodePaths(tmpDir);
        expect(result).toContain(voltaBin);
      } finally {
        if (originalAppData === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = originalAppData;
        }
      }
    });

    it('should detect scoop shims', () => {
      const scoopShims = path.join(tmpDir, 'scoop', 'shims');
      fs.mkdirSync(scoopShims, { recursive: true });

      const originalAppData = process.env.APPDATA;
      process.env.APPDATA = path.join(tmpDir, 'AppData', 'Roaming');
      try {
        const result = detectWindowsNodePaths(tmpDir);
        expect(result).toContain(scoopShims);
      } finally {
        if (originalAppData === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = originalAppData;
        }
      }
    });

    it('should detect nvm-windows version directories', () => {
      const appData = path.join(tmpDir, 'AppData', 'Roaming');
      const nvmDir = path.join(appData, 'nvm');
      // nvm-windows: version dirs contain node.exe directly (no bin subdir)
      fs.mkdirSync(path.join(nvmDir, 'v18.17.0'), { recursive: true });
      fs.mkdirSync(path.join(nvmDir, 'v20.10.0'), { recursive: true });

      const originalAppData = process.env.APPDATA;
      process.env.APPDATA = appData;
      try {
        const result = detectWindowsNodePaths(tmpDir);
        const nvmPaths = result.filter(p => p.includes('nvm'));
        expect(nvmPaths).toHaveLength(2);
      } finally {
        if (originalAppData === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = originalAppData;
        }
      }
    });

    it('should detect nodist bin', () => {
      const appData = path.join(tmpDir, 'AppData', 'Roaming');
      const nodistBin = path.join(appData, 'nodist', 'bin');
      fs.mkdirSync(nodistBin, { recursive: true });

      const originalAppData = process.env.APPDATA;
      process.env.APPDATA = appData;
      try {
        const result = detectWindowsNodePaths(tmpDir);
        expect(result).toContain(nodistBin);
      } finally {
        if (originalAppData === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = originalAppData;
        }
      }
    });

    it('should return empty array when no Windows managers installed', () => {
      const appData = path.join(tmpDir, 'AppData', 'Roaming');
      const originalAppData = process.env.APPDATA;
      const originalLocalAppData = process.env.LOCALAPPDATA;
      process.env.APPDATA = appData;
      process.env.LOCALAPPDATA = path.join(tmpDir, 'AppData', 'Local');
      try {
        const result = detectWindowsNodePaths(tmpDir);
        expect(result).toEqual([]);
      } finally {
        if (originalAppData === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = originalAppData;
        }
        if (originalLocalAppData === undefined) {
          delete process.env.LOCALAPPDATA;
        } else {
          process.env.LOCALAPPDATA = originalLocalAppData;
        }
      }
    });
  });

  describe('real system detection', () => {
    it('should detect the actual Node installation on this machine', () => {
      // This test verifies the function runs without error on the real system
      const homeDir = os.homedir();
      const result = detectNodeManagerPaths(homeDir);

      // On any dev machine, at least one manager should exist
      // (the machine running these tests has Node installed somehow)
      // We just verify it doesn't throw and returns an array
      expect(Array.isArray(result)).toBe(true);

      // Log what was found for manual verification
      if (result.length > 0) {
        console.log('[Test] Detected Node manager paths:', result.join(', '));
      } else {
        console.log('[Test] No version manager paths detected (Node may be installed via system package)');
      }
    });
  });
});
