import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { config } from './config.js';
import { cleanOutput } from './formatter.js';

/**
 * CopilotBridge v2 — Pipe mode process manager.
 *
 * Spawns a fresh `copilot -p <prompt>` per message with `--resume=<sessionId>`
 * for conversation persistence. No PTY, no debounce — process exit = response complete.
 *
 * Based on the AgentSquad pattern (CopilotCliProcessManager.cs).
 */
export class CopilotBridge extends EventEmitter {
  constructor() {
    super();
    this.sessionId = null;
    this.busy = false;
    this.messageQueue = [];
    this.currentProcess = null;
    this.requestCount = 0;
    this.startTime = Date.now();
    this._loadSession();
  }

  _loadSession() {
    if (existsSync(config.stateFile)) {
      try {
        const state = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
        if (state.sessionId) {
          this.sessionId = state.sessionId;
          console.log(`[bridge] Resumed session: ${this.sessionId}`);
          return;
        }
      } catch (err) {
        console.warn(`[bridge] Failed to read state file: ${err.message}`);
      }
    }
    this.sessionId = randomUUID();
    this._saveSession();
    console.log(`[bridge] New session: ${this.sessionId}`);
  }

  _saveSession() {
    try {
      writeFileSync(config.stateFile, JSON.stringify({
        sessionId: this.sessionId,
        createdAt: new Date().toISOString(),
      }, null, 2));
    } catch (err) {
      console.error(`[bridge] Failed to save state: ${err.message}`);
    }
  }

  /** Start a new conversation session. Returns the new session ID. */
  newSession() {
    this.sessionId = randomUUID();
    this._saveSession();
    console.log(`[bridge] New session: ${this.sessionId}`);
    return this.sessionId;
  }

  /** Get current session ID. */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * Send a message to Copilot. If busy, queues it.
   * @param {string} text - The user's message
   * @param {string[]} imagePaths - Optional array of local image file paths
   * @returns {Promise<{text: string, exitCode: number}>}
   */
  async sendMessage(text, imagePaths = []) {
    if (this.busy) {
      return new Promise((resolve, reject) => {
        this.messageQueue.push({ text, imagePaths, resolve, reject });
        this.emit('queued', text, this.messageQueue.length);
      });
    }
    return this._executeMessage(text, imagePaths);
  }

  async _executeMessage(text, imagePaths = []) {
    this.busy = true;
    this.requestCount++;
    this.emit('busy', true);

    try {
      let prompt = text;
      if (imagePaths.length > 0) {
        const refs = imagePaths
          .map(p => `Please analyze the image at: ${p}`)
          .join('\n');
        prompt = `${refs}\n\n${text || 'What is in this image?'}`;
      }

      const result = await this._runCopilot(prompt);
      return result;
    } finally {
      this.busy = false;
      this.emit('busy', false);
      this._processNext();
    }
  }

  _runCopilot(prompt) {
    return new Promise((resolve, reject) => {
      const args = [
        '-p', prompt,
        '--no-ask-user',
        '--no-auto-update',
        '--no-custom-instructions',
        '--no-color',
        '--silent',
        '--allow-all',
        `--resume=${this.sessionId}`,
      ];

      if (config.copilot.model) {
        args.push('--model', config.copilot.model);
      }

      console.log(`[bridge] Spawning copilot (session=${this.sessionId.slice(0, 8)}...)`);

      const proc = spawn(config.copilot.path, args, {
        cwd: config.copilot.cwd,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately — prompt is passed via -p flag
      proc.stdin.end();

      this.currentProcess = proc;
      let stdout = '';
      let stderr = '';
      let settled = false;

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        stderr += s;
        if (s.trim()) console.log(`[copilot:stderr] ${s.trim()}`);
      });

      const timeoutMs = config.copilot.timeoutSeconds * 1000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[bridge] Copilot timed out after ${config.copilot.timeoutSeconds}s`);
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
        reject(new Error(`Copilot timed out after ${config.copilot.timeoutSeconds}s`));
      }, timeoutMs);

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.currentProcess = null;

        const response = cleanOutput(stdout);
        console.log(`[bridge] Copilot exited (code=${code}, stdout=${response.length} chars)`);

        if (response) {
          resolve({ text: response, exitCode: code });
        } else if (code !== 0) {
          const errMsg = stderr.trim() || `Process exited with code ${code}`;
          reject(new Error(errMsg));
        } else {
          resolve({ text: '(empty response)', exitCode: 0 });
        }
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.currentProcess = null;
        reject(err);
      });
    });
  }

  _processNext() {
    if (this.messageQueue.length === 0) return;
    const { text, imagePaths, resolve, reject } = this.messageQueue.shift();
    this._executeMessage(text, imagePaths).then(resolve).catch(reject);
  }

  /** Cancel the running copilot process and clear the queue. */
  cancel() {
    if (this.currentProcess) {
      try { this.currentProcess.kill('SIGTERM'); } catch {}
    }
    // Reject all queued messages
    for (const item of this.messageQueue) {
      item.reject(new Error('Cancelled'));
    }
    this.messageQueue = [];
  }

  getStatus() {
    return {
      state: this.busy ? 'busy' : 'idle',
      sessionId: this.sessionId,
      queueLength: this.messageQueue.length,
      requestCount: this.requestCount,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
    };
  }

  /** Verify the copilot CLI is installed and reachable. */
  async verifyCliAvailable() {
    return new Promise((resolve) => {
      const proc = spawn(config.copilot.path, ['--version'], {
        windowsHide: true,
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => resolve(code === 0 ? output.trim() : null));
      proc.on('error', () => resolve(null));
    });
  }

  /** Ensure the temp directory for image downloads exists. */
  ensureTempDir() {
    if (!existsSync(config.tempDir)) {
      mkdirSync(config.tempDir, { recursive: true });
    }
  }

  destroy() {
    this.cancel();
  }
}
