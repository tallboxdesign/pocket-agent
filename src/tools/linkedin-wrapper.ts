/**
 * LinkedIn skill wrapper -executes Python scripts via run.py
 *
 * Uses execFile (not exec) to avoid shell injection.
 * Scripts live in src/skills/linkedin/scripts/ (dev) or
 * process.resourcesPath/app/src/skills/linkedin/scripts/ (packaged).
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFile = promisify(execFileCb);

function getScriptsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'src', 'skills', 'linkedin', 'scripts');
  }
  return path.join(__dirname, '..', 'skills', 'linkedin', 'scripts');
}

/** Find python3 binary -check common paths since Electron apps have minimal PATH */
function findPython3(): string {
  const candidates = [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'python3'; // fallback to PATH
}

/**
 * Execute a LinkedIn skill script via run.py
 */
export async function linkedinExec(script: string, args: string[], timeoutMs = 120000): Promise<string> {
  const runPy = path.join(getScriptsDir(), 'run.py');
  const python = findPython3();

  // Start from the parent env so Chromium keeps the normal macOS session/profile
  // context, then strip only the Electron/runtime variables that previously
  // caused Patchright's Chromium to crash under Electron.
  const home = process.env.HOME || os.homedir();
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (
      key.startsWith('ELECTRON') ||
      key.startsWith('CHROME_') ||
      key.startsWith('GOOGLE_') ||
      key.startsWith('DYLD_') ||
      key === '__CFBundleIdentifier' ||
      key === 'MallocNanoZone' ||
      key === 'NODE_ENV' ||
      key === 'ORIGINAL_XDG_CURRENT_DESKTOP'
    ) {
      delete cleanEnv[key];
    }
  }
  const execEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(cleanEnv).filter(([, value]) => typeof value === 'string')
    ) as Record<string, string>,
    HOME: home,
    USER: process.env.USER || cleanEnv.USER || '',
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${cleanEnv.PATH || ''}`,
    TMPDIR: process.env.TMPDIR || cleanEnv.TMPDIR || '/tmp',
    LANG: process.env.LANG || cleanEnv.LANG || 'en_US.UTF-8',
    SHELL: process.env.SHELL || cleanEnv.SHELL || '/bin/zsh',
    PYTHONUNBUFFERED: '1',
  };
  console.log(`[LinkedIn] exec: ${python} ${runPy} ${script} ${args.join(' ')}`);
  console.log(`[LinkedIn] HOME=${execEnv.HOME}, isPackaged=${app.isPackaged}, scriptsDir=${path.dirname(runPy)}`);
  try {
    // Launch via /bin/sh to fully detach from Electron's process tree
    // This prevents macOS from applying Electron's sandbox to child Chromium
    const escapedArgs = [runPy, script, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const shellCmd = `${python} ${escapedArgs}`;
    const { stdout, stderr } = await execFile('/bin/sh', ['-c', shellCmd], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB for feed results
      env: execEnv,
    });
    if (stderr) {
      console.log(`[LinkedIn] stderr: ${stderr.slice(0, 500)}`);
    }
    console.log(`[LinkedIn] stdout length: ${stdout.length}, first 200: ${stdout.slice(0, 200)}`);
    // Write diagnostic log to file
    const logPath = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'data', 'exec_log.txt');
    fs.appendFileSync(logPath, `\n---\n${new Date().toISOString()}\ncmd: ${python} ${runPy} ${script} ${args.join(' ')}\nstdout_len: ${stdout.length}\nstderr_len: ${stderr?.length || 0}\nstderr: ${stderr?.slice(0, 500) || ''}\nstdout_head: ${stdout.slice(0, 500)}\n`);
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    console.error(`[LinkedIn] exec failed: ${err.message}`);
    if (err.stderr) console.error(`[LinkedIn] stderr: ${err.stderr.slice(0, 500)}`);
    if (err.stdout) console.log(`[LinkedIn] stdout (partial): ${err.stdout.slice(0, 200)}`);
    // Write error diagnostic
    const logPath = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'data', 'exec_log.txt');
    fs.appendFileSync(logPath, `\n---\n${new Date().toISOString()}\nERROR: ${err.message}\nstderr: ${err.stderr?.slice(0, 1000) || ''}\nstdout: ${err.stdout?.slice(0, 500) || ''}\n`);
    throw error;
  }
}
