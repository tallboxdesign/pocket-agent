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

  // Build a minimal clean env from scratch — inheriting Electron's full env
  // (even after stripping ELECTRON_* vars) leaks macOS security context
  // (__CFBundleIdentifier, DYLD_*, MallocNanoZone, etc.) that causes
  // the child Chromium to crash with SIGTRAP under Electron's sandbox.
  const home = process.env.HOME || os.homedir();
  const execEnv: Record<string, string> = {
    HOME: home,
    USER: process.env.USER || '',
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHELL: process.env.SHELL || '/bin/zsh',
    PYTHONUNBUFFERED: '1',
    XPC_FLAGS: '0x0',
    XPC_SERVICE_NAME: '0',
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
