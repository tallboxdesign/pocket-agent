const fs = require('fs');
const path = require('path');

/**
 * electron-builder afterPack hook to reduce app size
 * Removes unused platform binaries and locale files
 */
exports.default = async function(context) {
  const appOutDir = context.appOutDir;
  const arch = context.arch === 1 ? 'x64' : 'arm64'; // 1 = x64, 3 = arm64
  const platform = process.platform;

  console.log(`[afterPack] Cleaning up for ${platform}-${arch}...`);

  const resourcesPath = path.join(appOutDir, 'Pocket Agent.app', 'Contents', 'Resources');
  const appPath = path.join(resourcesPath, 'app');

  // 1. Remove unused ripgrep platform binaries (~41MB savings)
  const ripgrepPath = path.join(appPath, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep');
  if (fs.existsSync(ripgrepPath)) {
    const keepPlatform = `${arch}-darwin`;
    const entries = fs.readdirSync(ripgrepPath);

    for (const entry of entries) {
      const entryPath = path.join(ripgrepPath, entry);
      const stat = fs.statSync(entryPath);

      if (stat.isDirectory() && entry !== keepPlatform) {
        console.log(`[afterPack] Removing ripgrep/${entry}`);
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  }

  // 2. Remove unused locale files (keep only en)
  const localeFiles = fs.readdirSync(resourcesPath).filter(f => f.endsWith('.lproj') && f !== 'en.lproj');
  for (const locale of localeFiles) {
    const localePath = path.join(resourcesPath, locale);
    console.log(`[afterPack] Removing locale ${locale}`);
    fs.rmSync(localePath, { recursive: true, force: true });
  }

  // 3. Remove unnecessary files from node_modules
  const nodeModulesPath = path.join(appPath, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    // Remove markdown, license duplicates, and test files
    const patternsToRemove = [
      '**/CHANGELOG.md',
      '**/HISTORY.md',
      '**/README.md',
      '**/*.md',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/docs/**',
      '**/example/**',
      '**/examples/**',
      '**/.github/**',
    ];

    // Simple cleanup - remove common unnecessary files
    cleanDirectory(nodeModulesPath, ['.md', '.markdown']);
  }

  // 4. Compile speech transcriber binary for the target architecture
  const sourceFile = path.join(appPath, 'assets', 'transcribe-speech.m');
  const binaryFile = path.join(appPath, 'assets', 'transcribe-speech');
  if (fs.existsSync(sourceFile)) {
    const { execSync } = require('child_process');
    const target = arch === 'arm64' ? 'arm64-apple-macos13.0' : 'x86_64-apple-macos13.0';
    try {
      execSync(`clang -target ${target} -framework Speech -framework Foundation -O2 -o "${binaryFile}" "${sourceFile}"`, { stdio: 'pipe' });
      console.log(`[afterPack] Compiled transcribe-speech for ${arch}`);
      // Remove source file from bundle
      fs.unlinkSync(sourceFile);
      // Remove Swift source if present
      const swiftFile = path.join(appPath, 'assets', 'transcribe-speech.swift');
      if (fs.existsSync(swiftFile)) fs.unlinkSync(swiftFile);
    } catch (err) {
      console.warn(`[afterPack] Failed to compile transcribe-speech: ${err.message}`);
    }
  }

  console.log('[afterPack] Cleanup complete');
};

function cleanDirectory(dir, extensions) {
  if (!fs.existsSync(dir)) return;

  let removed = 0;
  const walk = (currentPath) => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Remove test/docs directories
        if (['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github'].includes(entry.name)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        // Remove markdown files (except LICENSE)
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext) && !entry.name.toLowerCase().includes('license')) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      }
    }
  };

  walk(dir);
  if (removed > 0) {
    console.log(`[afterPack] Removed ${removed} unnecessary files/directories`);
  }
}
