import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { config } from './config.js';
import { discoverSessions } from './sessions.js';
import { detectProjectServer, captureWebPage, closeBrowser } from './screenshot.js';
import { getMode, getModeLabel, isValidMode } from './modes.js';
import { auditLog } from './audit-log.js';

// ─── Permission helpers (delegated to modes.js) ────────────────────────

function getPermissionHandler(mode) {
  const modeConfig = getMode(mode);
  return (request, invocation) => {
    const decision = modeConfig.permission(request);
    const action = decision.kind === 'approve-once' ? 'approve' : 'reject';
    console.log(`[permissions] ${mode.toUpperCase()} ${action}: ${request.kind}`);
    return decision;
  };
}

function getExcludedTools(mode) {
  return getMode(mode).excludedTools;
}

/**
 * CopilotBridge v3 — Copilot SDK integration with permission modes.
 */
export class CopilotBridge extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.session = null;
    this.sessionId = null;
    this.mode = 'agent'; // default to full autonomy
    this.busy = false;
    this.messageQueue = [];
    this.requestCount = 0;
    this.startTime = Date.now();
    this._loadState();
  }

  _loadState() {
    if (existsSync(config.stateFile)) {
      try {
        const state = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
        if (state.sessionId) {
          this.sessionId = state.sessionId;
          console.log(`[bridge] Found saved session: ${this.sessionId.slice(0, 8)}…`);
        }
        if (state.mode && isValidMode(state.mode)) {
          this.mode = state.mode;
          console.log(`[bridge] Restored mode: ${this.mode}`);
        }
      } catch (err) {
        console.warn(`[bridge] ⚠️ State file corrupted or unreadable: ${err.message}. Starting fresh.`);
      }
    }
  }

  _saveState() {
    try {
      const tmp = config.stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify({
        sessionId: this.sessionId,
        mode: this.mode,
        savedAt: new Date().toISOString(),
      }, null, 2));
      renameSync(tmp, config.stateFile);
    } catch (err) {
      console.error(`[bridge] Failed to save state: ${err.message}`);
    }
  }

  /** Initialize the Copilot SDK client. */
  async start() {
    console.log('[bridge] Starting Copilot SDK client…');

    const clientOpts = {
      autoStart: true,
      autoRestart: true,
      cliArgs: ['--autopilot'],
    };

    if (config.copilot.cliPath) {
      clientOpts.cliPath = config.copilot.cliPath;
      console.log(`[bridge] Using CLI: ${config.copilot.cliPath}`);
    }

    console.log('[bridge] CLI args: --autopilot');
    this.client = new CopilotClient(clientOpts);
    await this.client.start();
    this._ownCliPid = this.client._process?.pid || null;
    console.log('[bridge] Copilot SDK client ready');

    await this._ensureSession();
    return this;
  }

  /** Build session config for the current mode. */
  _sessionConfig() {
    const cfg = {
      model: config.copilot.model,
      streaming: true,
      onPermissionRequest: getPermissionHandler(this.mode),
    };
    const excluded = getExcludedTools(this.mode);
    if (excluded.length > 0) {
      cfg.excludedTools = excluded;
    }

    // System message to inform the model of its actual permission state
    if (this.mode === 'agent') {
      cfg.systemMessage = 'You are running in Agent mode with full autopilot permissions. You CAN and SHOULD execute shell commands, read/write files, and use all tools directly. Do NOT tell the user to run commands manually — execute them yourself.';
    } else if (this.mode === 'ask') {
      cfg.systemMessage = 'You are running in Ask mode. You can read files for context but cannot execute shell commands or write files. Answer questions based on what you can read.';
    } else if (this.mode === 'plan') {
      cfg.systemMessage = 'You are running in Plan mode. Describe what you would do but do not execute any tools. Provide step-by-step plans the user can review.';
    }

    return cfg;
  }

  /** Apply server-side permission settings based on current mode. */
  async _applyServerPermissions(session) {
    try {
      if (this.mode === 'agent') {
        await session.rpc.permissions.setApproveAll({ enabled: true });
        console.log('[bridge] Server-side setApproveAll: ENABLED');
      } else {
        await session.rpc.permissions.setApproveAll({ enabled: false });
        console.log('[bridge] Server-side setApproveAll: DISABLED');
      }
    } catch (err) {
      console.warn(`[bridge] setApproveAll RPC failed (non-fatal): ${err.message}`);
    }
  }

  /** Create or resume the persistent session. */
  async _ensureSession() {
    if (this.session) return this.session;

    const sessionCfg = this._sessionConfig();

    if (this.sessionId) {
      try {
        console.log(`[bridge] Resuming session ${this.sessionId.slice(0, 8)}… (mode: ${this.mode})`);
        this.session = await this.client.resumeSession(this.sessionId, sessionCfg);
        console.log(`[bridge] Session resumed successfully`);
        await this._applyServerPermissions(this.session);
        return this.session;
      } catch (err) {
        console.warn(`[bridge] Could not resume session: ${err.message}. Creating new.`);
        this.sessionId = null;
      }
    }

    console.log(`[bridge] Creating new session (model: ${config.copilot.model}, mode: ${this.mode})`);
    this.session = await this.client.createSession(sessionCfg);
    this.sessionId = this.session.sessionId;
    this._saveState();
    console.log(`[bridge] New session: ${this.sessionId.slice(0, 8)}…`);
    await this._applyServerPermissions(this.session);
    return this.session;
  }

  /** Change the permission mode. Reconnects the session with new config. */
  async setMode(newMode) {
    if (!isValidMode(newMode)) {
      throw new Error(`Invalid mode: ${newMode}. Use: agent, ask, plan`);
    }
    if (newMode === this.mode) return this.mode;

    const oldMode = this.mode;
    this.mode = newMode;
    this._saveState();
    console.log(`[bridge] Mode: ${oldMode} → ${newMode}`);

    // Disconnect current session
    if (this.session) {
      try { await this.session.disconnect(); } catch {}
      this.session = null;
    }

    // When switching TO agent mode, always start fresh to clear any
    // conversation history where the model learned it was restricted.
    if (newMode === 'agent') {
      this.sessionId = null;
      console.log('[bridge] Agent mode: creating fresh session (clearing restriction history)');
    }

    try {
      await this._ensureSession();
    } catch (err) {
      console.error(`[bridge] Failed to reconnect after mode change: ${err.message}`);
      this.mode = oldMode;
      this._saveState();
      throw err;
    }

    return this.mode;
  }

  async sendMessage(text, imagePaths = []) {
    if (this.busy) {
      return new Promise((resolve, reject) => {
        this.messageQueue.push({ text, imagePaths, resolve, reject });
        this.emit('queued', this.messageQueue.length);
      });
    }
    return this._executeMessage(text, imagePaths);
  }

  async _executeMessage(text, imagePaths = []) {
    this.busy = true;
    this.requestCount++;
    this.emit('busy', true);
    const startMs = Date.now();

    try {
      const session = await this._ensureSession();
      const result = await this._runWithEvents(session, text, imagePaths);
      auditLog({
        type: 'message', mode: this.mode, prompt: text,
        response: result.text, tools: result.tools,
        durationMs: Date.now() - startMs, timedOut: result.timedOut,
      });
      return result;
    } catch (err) {
      if (/closed|destroy|disposed|invalid|expired|not found/i.test(err.message)) {
        console.warn(`[bridge] Session appears dead, recreating…`);
        this.session = null;
        this.sessionId = null;
        try {
          const session = await this._ensureSession();
          const result = await this._runWithEvents(session, text, imagePaths);
          auditLog({
            type: 'message-retry', mode: this.mode, prompt: text,
            response: result.text, tools: result.tools,
            durationMs: Date.now() - startMs, timedOut: result.timedOut,
          });
          return result;
        } catch (retryErr) {
          auditLog({ type: 'error', mode: this.mode, prompt: text, error: retryErr.message, durationMs: Date.now() - startMs });
          throw retryErr;
        }
      }
      auditLog({ type: 'error', mode: this.mode, prompt: text, error: err.message, durationMs: Date.now() - startMs });
      throw err;
    } finally {
      this.busy = false;
      this.emit('busy', false);
      this._processNext();
    }
  }

  async _runWithEvents(session, text, imagePaths) {
    const tools = [];
    let accumulated = '';
    let lastToolName = '';

    const unsubDelta = session.on('assistant.message_delta', (event) => {
      accumulated += event.data.deltaContent;
      this.emit('delta', accumulated);
    });

    const unsubToolStart = session.on('tool.execution_start', (event) => {
      const toolName = event.data?.toolName || event.data?.name || 'tool';
      tools.push(toolName);
      lastToolName = toolName;
      this.emit('tool_start', toolName);
    });

    const unsubToolDone = session.on('tool.execution_complete', (event) => {
      const toolName = event.data?.toolName || event.data?.name || 'tool';
      this.emit('tool_done', toolName);
    });

    try {
      const attachments = imagePaths.map(path => ({
        type: 'file',
        path,
        displayName: 'image',
      }));

      const opts = { prompt: text };
      if (attachments.length > 0) {
        opts.attachments = attachments;
      }

      const result = await session.sendAndWait(opts, config.copilot.timeoutMs);
      const finalText = result?.data?.content || accumulated || '(No response)';

      return { text: finalText, tools };
    } catch (err) {
      // On timeout, return whatever content we accumulated via streaming
      if (/timeout/i.test(err.message) && accumulated.length > 0) {
        console.warn(`[bridge] Timeout after ${config.copilot.timeoutMs}ms — returning ${accumulated.length} chars of accumulated content`);
        const suffix = `\n\n⏱️ _Response was still in progress when the ${Math.round(config.copilot.timeoutMs / 1000)}s timeout was reached. The work may still be running in the background. Send a follow-up message to check status._`;
        return { text: accumulated + suffix, tools, timedOut: true };
      }
      // On timeout with no content, report what tools were running
      if (/timeout/i.test(err.message)) {
        console.warn(`[bridge] Timeout with no accumulated content. Tools used: ${tools.join(', ') || 'none'}`);
        const toolInfo = tools.length > 0
          ? `Tools executed: ${tools.join(', ')}`
          : 'No tool output captured';
        return {
          text: `⏱️ The request timed out after ${Math.round(config.copilot.timeoutMs / 1000)} seconds, but the work may still be running in the background.\n\n${toolInfo}\n\nSend a follow-up message like "what's the status?" to check progress.`,
          tools,
          timedOut: true,
        };
      }
      throw err;
    } finally {
      unsubDelta();
      unsubToolStart();
      unsubToolDone();
    }
  }

  _processNext() {
    if (this.messageQueue.length === 0) return;
    const { text, imagePaths, resolve, reject } = this.messageQueue.shift();
    this._executeMessage(text, imagePaths).then(resolve).catch(reject);
  }

  async newSession() {
    if (this.session) {
      try { await this.session.disconnect(); } catch {}
    }
    this.session = null;
    this.sessionId = null;

    console.log('[bridge] Creating fresh session…');
    const session = await this._ensureSession();
    return session.sessionId;
  }

  async cancel() {
    if (this.session) {
      try { await this.session.abort(); } catch {}
    }
    for (const item of this.messageQueue) {
      item.reject(new Error('Cancelled'));
    }
    this.messageQueue = [];
  }

  async listModels() {
    if (!this.client) return [];
    try {
      return await this.client.listModels();
    } catch {
      return [];
    }
  }

  listActiveSessions() {
    return discoverSessions(this._ownCliPid);
  }

  async switchSession(sessionId, cwd = null) {
    if (this.busy) {
      throw new Error('Cannot switch sessions while a request is in progress.');
    }

    if (this.session) {
      try { await this.session.disconnect(); } catch {}
      this.session = null;
    }

    console.log(`[bridge] Switching to session ${sessionId.slice(0, 8)}… (cwd: ${cwd || 'default'}, mode: ${this.mode})`);

    this.session = await this.client.resumeSession(sessionId, this._sessionConfig());
    this.sessionId = sessionId;
    this._saveState();
    await this._applyServerPermissions(this.session);
    console.log(`[bridge] Switched to session ${sessionId.slice(0, 8)}…`);
    return sessionId;
  }

  getStatus() {
    return {
      state: this.busy ? 'busy' : 'idle',
      sessionId: this.sessionId,
      model: config.copilot.model,
      mode: this.mode,
      modeLabel: getModeLabel(this.mode),
      queueLength: this.messageQueue.length,
      requestCount: this.requestCount,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
    };
  }

  ensureTempDir() {
    if (!existsSync(config.tempDir)) {
      mkdirSync(config.tempDir, { recursive: true });
    }
  }

  /** Capture a screenshot of the primary screen, returns the file path. */
  async captureScreen() {
    this.ensureTempDir();
    const filePath = join(config.tempDir, `screenshot-${Date.now()}.png`);

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$bmp.Save('${filePath.replace(/\\/g, '\\\\')}')
$g.Dispose(); $bmp.Dispose()
Write-Output 'OK'
`.trim();

    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        timeout: 15000,
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Screenshot capture failed: ${err.message}`));
          return;
        }
        if (!existsSync(filePath)) {
          reject(new Error(`Screenshot file not created. stderr: ${stderr}`));
          return;
        }
        console.log(`[bridge] Screenshot captured: ${filePath}`);
        resolve(filePath);
      });
    });
  }

  /**
   * Smart screenshot: detect running web app and capture it with Playwright.
   *
   * @param {string|null} urlOrMode
   *   - null / undefined → auto-detect running server for current project
   *   - "desktop" → raw desktop capture (existing captureScreen)
   *   - a URL string → screenshot that specific URL
   * @returns {Promise<{filePath: string, mode: string, url?: string, port?: number}>}
   */
  async captureFeature(urlOrMode = null) {
    // Desktop fallback
    if (urlOrMode === 'desktop') {
      const filePath = await this.captureScreen();
      return { filePath, mode: 'desktop' };
    }

    // Explicit URL
    if (urlOrMode && /^https?:\/\//.test(urlOrMode)) {
      const filePath = await captureWebPage(urlOrMode);
      return { filePath, mode: 'url', url: urlOrMode };
    }

    // Auto-detect: find the project directory from sessions
    let projectDir = null;

    // Try to find the project dir from the active session's discovered sessions
    if (this.sessionId) {
      try {
        const sessions = this.listActiveSessions();
        const match = sessions.find(s => s.sessionId === this.sessionId);
        if (match?.projectPath) {
          projectDir = match.projectPath;
        }
      } catch {}
    }

    // If no project dir from session, try bridge cwd
    if (!projectDir) {
      projectDir = process.cwd();
    }

    console.log(`[bridge] captureFeature: auto-detecting server for ${projectDir}`);
    const server = await detectProjectServer(projectDir);

    if (server) {
      const url = `http://localhost:${server.port}`;
      console.log(`[bridge] Found server at ${url} (PID: ${server.pid})`);
      try {
        const filePath = await captureWebPage(url);
        return { filePath, mode: 'auto', url, port: server.port };
      } catch (err) {
        console.warn(`[bridge] Playwright capture failed: ${err.message}, falling back to desktop`);
        const filePath = await this.captureScreen();
        return { filePath, mode: 'desktop-fallback', url };
      }
    }

    // No server found — return info, don't auto-fallback to desktop
    return { filePath: null, mode: 'no-server', projectDir };
  }

  /** Delete a temp file (for cleanup after sending). */
  cleanupFile(filePath) {
    try { unlinkSync(filePath); } catch {}
  }

  /**
   * Start a periodic health check for the SDK client.
   * Only checks when idle (busy-aware per rubber-duck).
   * Emits 'health_error' event on failure.
   */
  startHealthMonitor(intervalMs = 60000) {
    if (this._healthInterval) return;
    this._healthInterval = setInterval(async () => {
      if (this.busy || !this.client) return;
      try {
        // Lightweight check: list models as a ping
        await this.client.listModels();
      } catch (err) {
        console.error(`[health] SDK health check failed: ${err.message}`);
        this.emit('health_error', err);
        // Attempt to reconnect
        try {
          console.log('[health] Attempting SDK reconnect…');
          if (this.session) try { await this.session.disconnect(); } catch {}
          if (this.client) try { await this.client.stop(); } catch {}
          await this.start();
          console.log('[health] SDK reconnected successfully');
          this.emit('health_recovered');
        } catch (reconnErr) {
          console.error(`[health] Reconnect failed: ${reconnErr.message}`);
        }
      }
    }, intervalMs);
    this._healthInterval.unref();
  }

  stopHealthMonitor() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  async destroy() {
    this.stopHealthMonitor();
    await this.cancel();
    if (this.session) {
      try { await this.session.disconnect(); } catch {}
    }
    if (this.client) {
      try { await this.client.stop(); } catch {}
    }
    await closeBrowser();
  }
}
