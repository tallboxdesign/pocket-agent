const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Verify if a DMG file is valid by attempting to attach it (macOS only)
 */
function isDmgValid(dmgPath) {
  try {
    execSync(`hdiutil verify "${dmgPath}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the architecture from a DMG filename
 */
function getArchFromFilename(filename) {
  if (filename.includes('arm64')) return 'arm64';
  if (filename.includes('x64')) return 'x64';
  if (!filename.includes('arm64')) return 'x64';
  return null;
}

/**
 * electron-builder afterAllArtifactBuild hook
 * Validates and rebuilds corrupted DMG files (macOS only)
 * On Windows, this is a no-op pass-through
 */
exports.default = async function(context) {
  const { outDir, artifactPaths } = context;

  // DMG validation is macOS-only — skip entirely on other platforms
  if (process.platform !== 'darwin') {
    console.log('[afterAllArtifactBuild] Non-macOS build, skipping DMG validation');
    return artifactPaths;
  }

  const { createDmg } = require('./createDmg');

  for (const artifactPath of artifactPaths) {
    if (!artifactPath.endsWith('.dmg')) {
      continue;
    }

    const filename = path.basename(artifactPath);
    console.log(`[afterAllArtifactBuild] Checking DMG: ${filename}`);

    const isValid = isDmgValid(artifactPath);
    const stats = fs.statSync(artifactPath);
    const sizeMB = stats.size / (1024 * 1024);

    if (isValid) {
      console.log(`[afterAllArtifactBuild] DMG valid: ${filename} (${sizeMB.toFixed(2)}MB)`);
      continue;
    }

    console.log(`[afterAllArtifactBuild] DMG corrupted: ${filename} - rebuilding...`);

    const arch = getArchFromFilename(filename);
    if (!arch) {
      console.error(`[afterAllArtifactBuild] Could not determine architecture for: ${filename}`);
      continue;
    }

    const possibleAppDirs = [
      path.join(outDir, `mac-${arch}`),
      path.join(outDir, arch === 'x64' ? 'mac' : `mac-${arch}`),
    ];

    let appPath = null;
    for (const appDir of possibleAppDirs) {
      const candidatePath = path.join(appDir, 'Pocket Agent.app');
      if (fs.existsSync(candidatePath)) {
        appPath = candidatePath;
        break;
      }
    }

    if (!appPath) {
      console.error(`[afterAllArtifactBuild] App not found for ${arch} in:`, possibleAppDirs);
      continue;
    }

    console.log(`[afterAllArtifactBuild] Using app: ${appPath}`);

    const backgroundPath = path.join(__dirname, 'background.png');
    const hasBackground = fs.existsSync(backgroundPath);

    try {
      createDmg(appPath, artifactPath, {
        volumeName: 'Pocket Agent',
        background: hasBackground ? backgroundPath : null,
        iconSize: 80,
        windowWidth: 540,
        windowHeight: 380,
        appX: 130,
        appY: 190,
        applicationsX: 410,
        applicationsY: 190,
      });

      const newStats = fs.statSync(artifactPath);
      const newSizeMB = newStats.size / (1024 * 1024);

      if (isDmgValid(artifactPath)) {
        console.log(`[afterAllArtifactBuild] Rebuilt DMG valid: ${filename} (${newSizeMB.toFixed(2)}MB)`);
      } else {
        console.error(`[afterAllArtifactBuild] Rebuilt DMG still invalid: ${filename}`);
      }
    } catch (error) {
      console.error(`[afterAllArtifactBuild] Failed to rebuild DMG:`, error.message);
    }
  }

  return artifactPaths;
};
