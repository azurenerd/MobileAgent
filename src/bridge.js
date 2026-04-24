import pty from 'node-pty';
import { EventEmitter } from 'events';
import { config } from './config.js';
import { cleanOutput, stripEchoedInput } from './formatter.js';

/**
 * CopilotBridge manages the Copilot CLI process via a pseudo-terminal
 * and provides a clean event-based interface for sending/receiving messages.
 *
 * States: starting → idle ↔ streaming → (error)
 *
 * Events:
 *   'output'       - (cleanedText, rawText) assistant/CLI produced output
 *   'stateChange'  - (newState, oldState)
 *   'exit'         - (exitCode) CLI process exited
 *   'queued'       - (text, queueLength) message was queued because CLI is busy
 *   'error'        - (error) something went wrong
 */
export class CopilotBridge extends EventEmitter {
  constructor() {
    super();
    this.state = 'stopped';
    this.buffer = '';
    this.rawBuffer = '';
    this.debounceTimer = null;
    this.process = null;
    this.lastInput = null;
    this.messageQueue = [];
    this.startTime = null;
    this.requestCount = 0;
  }

  /**
   * Spawn the Copilot CLI in a pseudo-terminal.
   */
  start() {
    if (this.process) {
      this.destroy();
    }

    try {
      this.process = pty.spawn(config.copilot.path, [], {
        name: 'xterm-256color',
        cols: config.pty.cols,
        rows: config.pty.rows,
        cwd: config.copilot.cwd,
        env: { ...process.env },
      });
    } catch (err) {
      this._setState('error');
      this.emit('error', err);
      return;
    }

    this.process.onData((data) => this._handleOutput(data));

    this.process.onExit(({ exitCode, signal }) => {
      console.log(`[bridge] CLI exited: code=${exitCode} signal=${signal}`);
      this._setState('error');
      this.emit('exit', exitCode);
    });

    this.startTime = Date.now();
    this.requestCount = 0;
    this._setState('starting');

    console.log(`[bridge] Copilot CLI started (pid=${this.process.pid})`);
  }

  /**
   * Handle raw output from the PTY.
   */
  _handleOutput(data) {
    this.buffer += data;
    this.rawBuffer += data;

    // Reset debounce timer — wait for quiet period
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => this._flushBuffer(),
      config.outputDebounceMs
    );

    // Transition to streaming if we were idle/starting
    if (this.state === 'idle' || this.state === 'starting') {
      this._setState('streaming');
    }
  }

  /**
   * Called when output has been quiet for the debounce period.
   * Cleans the buffer and emits it as a message.
   */
  _flushBuffer() {
    const raw = this.rawBuffer;
    this.rawBuffer = '';

    let text = cleanOutput(this.buffer);
    this.buffer = '';

    // Strip echoed user input if we know what was last sent
    if (this.lastInput) {
      text = stripEchoedInput(text, this.lastInput);
      this.lastInput = null;
    }

    text = text.trim();

    if (text) {
      this.emit('output', text, raw);
    }

    this._setState('idle');

    // Process next queued message
    this._processNextMessage();
  }

  /**
   * Send a text message to the Copilot CLI.
   * If the CLI is busy, the message is queued.
   */
  sendInput(text) {
    if (!this.process) {
      this.emit('error', new Error('CLI is not running. Use /reset to restart.'));
      return false;
    }

    if (this.state !== 'idle') {
      this.messageQueue.push(text);
      this.emit('queued', text, this.messageQueue.length);
      return false;
    }

    this._writeInput(text);
    return true;
  }

  _writeInput(text) {
    this.lastInput = text;
    this.requestCount++;
    this.process.write(text + '\r');
    this._setState('streaming');
  }

  _processNextMessage() {
    if (this.messageQueue.length === 0) return;
    const next = this.messageQueue.shift();
    // Small delay to let the prompt settle
    setTimeout(() => this._writeInput(next), 300);
  }

  /**
   * Send a special key to the PTY (for interactive prompts, menus, etc.).
   */
  sendKey(keyName) {
    if (!this.process) return;

    const keyMap = {
      enter: '\r',
      esc: '\x1b',
      up: '\x1b[A',
      down: '\x1b[B',
      left: '\x1b[D',
      right: '\x1b[C',
      'ctrl-c': '\x03',
      'ctrl-d': '\x04',
      tab: '\t',
      backspace: '\x7f',
      y: 'y',
      n: 'n',
      space: ' ',
    };

    const code = keyMap[keyName.toLowerCase()];
    if (code) {
      this.process.write(code);
      return true;
    }
    return false;
  }

  /**
   * Send Ctrl+C to cancel the current operation.
   */
  cancel() {
    if (!this.process) return;
    this.process.write('\x03');
    this.messageQueue = [];
    this.buffer = '';
    this.rawBuffer = '';
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this._setState('idle');
  }

  /**
   * Kill and restart the CLI process.
   */
  reset() {
    console.log('[bridge] Resetting CLI...');
    this.destroy();
    setTimeout(() => this.start(), 500);
  }

  /**
   * Get current bridge status.
   */
  getStatus() {
    const uptime = this.startTime
      ? Math.round((Date.now() - this.startTime) / 1000)
      : 0;

    return {
      state: this.state,
      pid: this.process?.pid ?? null,
      queueLength: this.messageQueue.length,
      bufferSize: this.buffer.length,
      requestCount: this.requestCount,
      uptimeSeconds: uptime,
    };
  }

  _setState(newState) {
    const old = this.state;
    if (old === newState) return;
    this.state = newState;
    this.emit('stateChange', newState, old);
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // already dead
      }
      this.process = null;
    }
    this.buffer = '';
    this.rawBuffer = '';
    this.messageQueue = [];
    this.lastInput = null;
    this._setState('stopped');
  }
}
