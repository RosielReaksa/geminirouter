import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export class CoreProcessManager {
  private process: ChildProcess | null = null;
  private coreMainPath: string;

  constructor() {
    // The core is an external dependency, resolved via CORE_MAIN_PATH or CORE_HOME.
    const coreHome = process.env.CORE_HOME || '';
    const candidates = [
      process.env.CORE_MAIN_PATH || '',
      coreHome ? path.join(coreHome, 'dist', 'core', 'main.cjs') : '',
      path.resolve(process.cwd(), '../core/dist/core/main.cjs'),
      path.resolve('/opt/geminirouter/core/dist/core/main.cjs'),
      path.resolve(process.cwd(), '../AntigravityManager/dist/core/main.cjs'),
    ].filter(Boolean);

    let found = '';
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        found = c;
        break;
      }
    }
    this.coreMainPath = found || candidates[0];
  }

  isProcessAlive(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  getCoreScriptPath(): string {
    return this.coreMainPath;
  }

  startCore(): { success: boolean; message: string; pid?: number } {
    if (this.isProcessAlive()) {
      return {
        success: true,
        message: 'Core process is already running',
        pid: this.process?.pid,
      };
    }

    if (!fs.existsSync(this.coreMainPath)) {
      return {
        success: false,
        message: `Core bundle not found at ${this.coreMainPath}. Install the AntigravityManager core separately and set CORE_MAIN_PATH (or CORE_HOME) to its location.`,
      };
    }

    try {
      const child = spawn(process.execPath, [this.coreMainPath], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
        },
      });

      this.process = child;

      child.stdout?.on('data', (data) => {
        const str = data.toString().trim();
        if (str) {
          console.log(`[CoreProcess stdout] ${str}`);
        }
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString().trim();
        if (str) {
          console.error(`[CoreProcess stderr] ${str}`);
        }
      });

      child.on('exit', (code, signal) => {
        console.warn(`[CoreProcess] Exited with code=${code}, signal=${signal}`);
        this.process = null;
      });

      return {
        success: true,
        message: `Core process spawned successfully (PID: ${child.pid})`,
        pid: child.pid,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to spawn core process: ${err?.message || String(err)}`,
      };
    }
  }

  stopCore(): { success: boolean; message: string } {
    if (!this.process || this.process.exitCode !== null) {
      this.process = null;
      return { success: true, message: 'Core process not running' };
    }

    try {
      this.process.kill();
      this.process = null;
      return { success: true, message: 'Core process stopped' };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to stop core process: ${err?.message || String(err)}`,
      };
    }
  }
}
