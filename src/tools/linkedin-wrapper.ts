/**
 * LinkedIn skill wrapper — executes Python scripts via run.py
 *
 * Uses execFile (not exec) to avoid shell injection.
 * Scripts live in src/skills/linkedin/scripts/ (dev) or
 * process.resourcesPath/app/src/skills/linkedin/scripts/ (packaged).
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import path from 'path';

const execFile = promisify(execFileCb);

function getScriptsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'src', 'skills', 'linkedin', 'scripts');
  }
  return path.join(__dirname, '..', 'skills', 'linkedin', 'scripts');
}

/**
 * Execute a LinkedIn skill script via run.py
 */
export async function linkedinExec(script: string, args: string[], timeoutMs = 120000): Promise<string> {
  const runPy = path.join(getScriptsDir(), 'run.py');
  const { stdout } = await execFile('python3', [runPy, script, ...args], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10MB for feed results
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  return stdout.trim();
}
