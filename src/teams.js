/**
 * Microsoft Teams transport for Copilot Mobile Bridge.
 *
 * Uses Microsoft Graph API with OAuth PKCE (Squad framework pattern).
 * Polls for incoming messages, posts responses as HTML.
 *
 * @module teams
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { TeamsAuth } from './teams-auth.js';
import {
  graphFetch, getMe, ensureChat,
  postMessage, postMessageWithImage, editMessage as graphEditMessage,
  fetchMessages, stripHtml,
} from './teams-graph.js';
import {
  formatAssistant, formatToolActivity, formatSystem,
  formatThinking, formatSuccess, chunkMessage, escapeHtml,
} from './teams-formatter.js';
import { formatRelativeTime } from './sessions.js';
import { getModeLabel } from './modes.js';
import { getRecentAuditEntries, getAuditEntriesSince, formatAuditEntries } from './audit-log.js';
import { createLogger } from './logger.js';

const log = createLogger('teams');

// ─── Watermark Persistence ──────────────────────────────────────────

const WATERMARK_FILE = join(config.tempDir || '.', 'teams-watermark.json');

function loadWatermark() {
  try {
    if (existsSync(WATERMARK_FILE)) {
      return JSON.parse(readFileSync(WATERMARK_FILE, 'utf-8'));
    }
  } catch {}
  return { lastMessageId: null, lastTimestamp: null, processedIds: [] };
}

function saveWatermark(wm) {
  try {
    writeFileSync(WATERMARK_FILE, JSON.stringify(wm, null, 2));
  } catch (err) {
    log.warn('Failed to save watermark:', err.message);
  }
}

// ─── LRU Set for Dedup ─────────────────────────────────────────────

class LruSet {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.set = new Set();
  }
  has(val) { return this.set.has(val); }
  add(val) {
    this.set.add(val);
    if (this.set.size > this.maxSize) {
      const first = this.set.values().next().value;
      this.set.delete(first);
    }
  }
  toArray() { return [...this.set]; }
  loadFrom(arr) { for (const v of arr) this.add(v); }
}

/**
 * Create and configure the Teams transport.
 * Returns { start, sendHtml, shutdown }.
 */
export function createTeamsBot(bridge) {
  const auth = new TeamsAuth(config.teams.clientId, config.teams.tenantId);
  let chatId = config.teams.chatId || null;
  let myUserId = null;
  let isSelfChat = false; // true when recipientUpn is 'me' (self-chat mode)
  let pollingActive = false;
  let pollTimer = null;
  const processedIds = new LruSet(500);
  const sentByBridge = new LruSet(200); // message IDs posted by this bridge instance

  // Load persisted watermark
  const watermark = loadWatermark();
  let lastPollTimestamp = watermark.lastTimestamp ? new Date(watermark.lastTimestamp) : null;
  if (watermark.processedIds) processedIds.loadFrom(watermark.processedIds);

  // ─── Send helpers ───────────────────────────────────────────────

  async function sendHtml(targetChatId, text) {
    const chunks = chunkMessage(text);
    let lastMsg = null;
    for (const chunk of chunks) {
      try {
        const accessToken = await auth.ensureAuthenticated();
        lastMsg = await postMessage(accessToken, targetChatId, chunk);
        if (lastMsg?.id) sentByBridge.add(lastMsg.id);
      } catch (err) {
        log.error('Failed to send Teams message:', err.message);
      }
    }
    return lastMsg;
  }

  async function editOrSendNew(targetChatId, messageId, text) {
    const chunks = chunkMessage(text);
    try {
      const accessToken = await auth.ensureAuthenticated();
      await graphEditMessage(accessToken, targetChatId, messageId, chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        const overflow = await postMessage(accessToken, targetChatId, chunks[i]);
        if (overflow?.id) sentByBridge.add(overflow.id);
      }
    } catch (err) {
      log.warn('Edit failed, sending new message:', err.message);
      await sendHtml(targetChatId, text);
    }
  }

  async function sendPhoto(targetChatId, filePath, caption = '') {
    try {
      const accessToken = await auth.ensureAuthenticated();
      const msg = await postMessageWithImage(accessToken, targetChatId, '', filePath, caption);
      if (msg?.id) sentByBridge.add(msg.id);
      return msg;
    } catch (err) {
      log.error('Failed to send photo:', err.message);
      await sendHtml(targetChatId, formatSystem(`❌ Photo send failed: ${err.message}`));
    }
  }

  // ─── State for /retry ─────────────────────────────────────────

  let lastUserText = null;
  let lastResultTimedOut = false;
  let lastSessionList = [];

  // ─── Core: process a user message through Copilot ─────────────

  async function handleUserMessage(text, imagePaths = []) {
    lastUserText = text;
    lastResultTimedOut = false;
    const startTime = Date.now();

    // Send thinking indicator
    let statusMsg = await sendHtml(chatId, formatThinking());
    const statusMsgId = statusMsg?.id;

    // Track tool activity for live updates
    let lastToolUpdate = 0;
    let toolsUsed = [];
    const onToolStart = async (toolName) => {
      toolsUsed.push(toolName);
      const now = Date.now();
      if (statusMsgId && now - lastToolUpdate > 3000) {
        lastToolUpdate = now;
        try {
          await editOrSendNew(chatId, statusMsgId, formatToolActivity(toolName));
        } catch {}
      }
    };

    // Progress updates
    let progressInterval = null;
    let initialTimeout = null;
    if (statusMsgId) {
      initialTimeout = setTimeout(async () => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        try {
          await editOrSendNew(chatId, statusMsgId, `🔄 <em>Processing… (${elapsed}s)</em>`);
        } catch {}
      }, 5000);

      progressInterval = setInterval(async () => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const toolInfo = toolsUsed.length > 0
          ? `<br/>Tools: ${toolsUsed.slice(-3).join(', ')}${toolsUsed.length > 3 ? ` (+${toolsUsed.length - 3} more)` : ''}`
          : '';
        try {
          await editOrSendNew(chatId, statusMsgId, `🔄 <em>Working… (${elapsed}s elapsed)${toolInfo}</em>`);
        } catch {}
      }, 8000);
    }

    bridge.on('tool_start', onToolStart);

    try {
      const result = await bridge.sendMessage(text, imagePaths);
      bridge.off('tool_start', onToolStart);
      if (initialTimeout) clearTimeout(initialTimeout);
      if (progressInterval) clearInterval(progressInterval);
      if (result.timedOut) lastResultTimedOut = true;

      const formatted = formatAssistant(result.text);
      if (formatted && statusMsgId) {
        await editOrSendNew(chatId, statusMsgId, formatted);
      } else if (formatted) {
        await sendHtml(chatId, formatted);
      } else if (statusMsgId) {
        await editOrSendNew(chatId, statusMsgId, formatSystem('(empty response)'));
      }
    } catch (err) {
      bridge.off('tool_start', onToolStart);
      if (initialTimeout) clearTimeout(initialTimeout);
      if (progressInterval) clearInterval(progressInterval);

      const errText = formatSystem(`❌ Error: ${err.message}`);
      if (statusMsgId) {
        await editOrSendNew(chatId, statusMsgId, errText);
      } else {
        await sendHtml(chatId, errText);
      }
    }
  }

  // ─── Command Handlers ─────────────────────────────────────────

  async function handleCommand(text) {
    const trimmed = text.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
    const arg = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

    switch (cmd) {
      case '/start':
      case '/help':
        await sendHtml(chatId,
          `<b>Modes:</b><br/>` +
          `  /agent — 🤖 Full autonomy (run commands, write files)<br/>` +
          `  /ask — 💬 Read-only (answer questions)<br/>` +
          `  /plan — 📋 Suggest-only (describe, don't execute)<br/><br/>` +
          `<b>Sessions:</b><br/>` +
          `  /sessions — List active CLI terminal sessions<br/>` +
          `  /switch N — Connect to session N<br/>` +
          `  /new — Fresh conversation<br/><br/>` +
          `<b>Other:</b><br/>` +
          `  /screenshot — 📸 Auto-detect &amp; capture running app<br/>` +
          `  /screenshot [url] — Capture a specific URL<br/>` +
          `  /screenshot desktop — Raw desktop capture<br/>` +
          `  /summarize N — Summarize last N minutes<br/>` +
          `  /retry — Resend last message<br/>` +
          `  /history — Recent activity log<br/>` +
          `  /last — Details of last request<br/>` +
          `  /status — Session info, mode &amp; uptime<br/>` +
          `  /cancel — Cancel current request<br/>` +
          `  /model [name] — Current model or switch model<br/><br/>` +
          `<b>Tips:</b><br/>` +
          `  • /sessions to see your open terminals<br/>` +
          `  • /agent before asking it to do work<br/>` +
          `  • /status shows current mode and uptime`
        );
        break;

      case '/status': {
        const s = bridge.getStatus();
        const emoji = s.state === 'idle' ? '🟢' : '⏳';
        await sendHtml(chatId,
          `${emoji} <b>Status</b><br/><br/>` +
          `<b>Session:</b> <code>${s.sessionId?.slice(0, 8) ?? 'none'}…</code><br/>` +
          `<b>Mode:</b> ${getModeLabel(s.mode)}<br/>` +
          `<b>Model:</b> ${s.model}<br/>` +
          `<b>State:</b> ${s.state}<br/>` +
          `<b>Requests:</b> ${s.requestCount}<br/>` +
          `<b>Uptime:</b> ${Math.round(s.uptime / 60000)}m<br/>` +
          `<b>Transport:</b> Teams (Graph API)`
        );
        break;
      }

      case '/cancel':
        bridge.cancel();
        await sendHtml(chatId, formatSystem('Request cancelled.'));
        break;

      case '/history': {
        const entries = getRecentAuditEntries(10);
        if (entries.length === 0) {
          await sendHtml(chatId, formatSystem('No recent activity.'));
        } else {
          await sendHtml(chatId, `<b>📋 Recent Activity</b><br/><br/>${escapeHtml(formatAuditEntries(entries)).replace(/\n/g, '<br/>')}`);
        }
        break;
      }

      case '/last': {
        const entries = getRecentAuditEntries(1);
        if (entries.length === 0) {
          await sendHtml(chatId, formatSystem('No previous request.'));
        } else {
          const e = entries[0];
          await sendHtml(chatId,
            `<b>Last Request</b><br/><br/>` +
            `<b>Type:</b> ${e.type}<br/>` +
            `<b>Time:</b> ${e.timestamp}<br/>` +
            `<b>Duration:</b> ${e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : 'N/A'}<br/>` +
            `<b>Input:</b> ${escapeHtml((e.input || '').slice(0, 200))}`
          );
        }
        break;
      }

      case '/summarize': {
        const minutes = parseInt(arg, 10);
        if (!minutes || minutes <= 0) {
          await sendHtml(chatId, formatSystem('Usage: /summarize N (where N is minutes)'));
          return;
        }
        const entries = getAuditEntriesSince(minutes);
        if (entries.length === 0) {
          await sendHtml(chatId, formatSystem(`No activity in the last ${minutes} minutes.`));
          return;
        }
        const digest = entries.map(e => {
          const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const input = (e.input || '').slice(0, 80);
          const output = (e.output || '').slice(0, 80);
          return `[${time}] ${e.type}: ${input}${output ? ` → ${output}` : ''}`;
        }).join('\n');

        await sendHtml(chatId, formatSystem(`Summarizing ${entries.length} events from the last ${minutes} minutes…`));
        const prompt = `Summarize this session activity from the last ${minutes} minutes in 2-3 concise paragraphs. Focus on what was accomplished, any issues encountered, and current status:\n\n${digest}`;
        await handleUserMessage(prompt);
        break;
      }

      case '/new':
        try {
          await sendHtml(chatId, formatSystem('Creating new conversation…'));
          await bridge.newConversation();
          const s = bridge.getStatus();
          await sendHtml(chatId, formatSuccess(`New session: ${s.sessionId?.slice(0, 8)}… | Model: ${s.model}`));
        } catch (err) {
          await sendHtml(chatId, formatSystem(`❌ Failed: ${err.message}`));
        }
        break;

      case '/model':
        if (!arg) {
          const s = bridge.getStatus();
          await sendHtml(chatId, formatSystem(`Current model: ${s.model}`));
        } else {
          try {
            await sendHtml(chatId, formatSystem(`Switching model to ${arg}…`));
            await bridge.setModel(arg);
            await sendHtml(chatId, formatSuccess(`Model switched to ${arg}. New session started.`));
          } catch (err) {
            await sendHtml(chatId, formatSystem(`❌ Model switch failed: ${err.message}`));
          }
        }
        break;

      case '/agent':
        bridge.setMode('agent');
        await sendHtml(chatId, formatSystem('🤖 Mode: Agent (full autonomy)'));
        break;

      case '/ask':
        bridge.setMode('ask');
        await sendHtml(chatId, formatSystem('💬 Mode: Ask (read-only)'));
        break;

      case '/plan':
        bridge.setMode('plan');
        await sendHtml(chatId, formatSystem('📋 Mode: Plan (suggest only)'));
        break;

      case '/retry':
        if (!lastUserText) {
          await sendHtml(chatId, formatSystem('Nothing to retry.'));
        } else {
          await sendHtml(chatId, formatSystem(`Retrying: ${lastUserText.slice(0, 50)}…`));
          await handleUserMessage(lastUserText);
        }
        break;

      case '/screenshot': {
        try {
          let label;
          if (arg === 'desktop') {
            label = 'Capturing desktop…';
          } else if (/^https?:\/\//.test(arg)) {
            label = `Capturing ${arg}…`;
          } else {
            label = 'Detecting running app…';
          }

          await sendHtml(chatId, `📸 <em>${escapeHtml(label)}</em>`);
          const result = await bridge.captureFeature(arg || null);

          if (result.mode === 'no-server') {
            await sendHtml(chatId,
              `📸 <b>No running web server detected</b><br/><br/>` +
              `Project: <code>${escapeHtml(result.projectDir || 'unknown')}</code><br/><br/>` +
              `Try:<br/>` +
              `• /screenshot http://localhost:3000 — specific URL<br/>` +
              `• /screenshot desktop — raw desktop capture<br/>` +
              `• Start a dev server first, then retry /screenshot`
            );
            return;
          }

          const tempFile = result.filePath;
          let caption = '';
          if (result.mode === 'auto' || result.mode === 'url') {
            caption = `🌐 Captured: ${result.url}`;
          } else if (result.mode === 'desktop-fallback') {
            caption = `🖥️ Desktop fallback (web capture failed for ${result.url || 'unknown'})`;
          } else {
            caption = `🖥️ Desktop screenshot`;
          }

          await sendPhoto(chatId, tempFile, caption);
          bridge.cleanupFile(tempFile);
        } catch (err) {
          await sendHtml(chatId, formatSystem(`❌ Screenshot failed: ${err.message}`));
        }
        break;
      }

      case '/sessions': {
        try {
          const sessions = bridge.listActiveSessions();
          lastSessionList = sessions;

          if (sessions.length === 0) {
            await sendHtml(chatId, formatSystem('No active Copilot CLI sessions found.'));
            return;
          }

          const currentId = bridge.getStatus().sessionId;
          const lines = ['🔍 <b>Active Copilot Sessions:</b><br/>'];

          sessions.forEach((s, i) => {
            const num = `${i + 1}.`;
            const isCurrent = s.sessionId === currentId;
            const marker = isCurrent ? ' ✅ <em>connected</em>' : '';
            const name = s.projectName || s.sessionId.slice(0, 8);
            const path = s.projectPath ? `<br/>     📁 <code>${escapeHtml(s.projectPath)}</code>` : '';
            const oneLiner = s.checkpointTitle || s.summary || null;
            const summary = oneLiner ? `<br/>     💬 <em>${escapeHtml(oneLiner.slice(0, 120))}</em>` : '';
            const time = s.lastActive ? `<br/>     🕐 ${formatRelativeTime(s.lastActive)}` : '';

            lines.push(`${num} <b>${escapeHtml(name)}</b>${marker}${path}${summary}${time}<br/>`);
          });

          lines.push('Reply /switch N to connect to a session.');
          await sendHtml(chatId, lines.join('<br/>'));
        } catch (err) {
          await sendHtml(chatId, formatSystem(`❌ Failed: ${err.message}`));
        }
        break;
      }

      case '/switch': {
        const num = parseInt(arg, 10);
        if (!arg || isNaN(num)) {
          await sendHtml(chatId, formatSystem('Usage: /switch N (run /sessions first)'));
          return;
        }
        if (lastSessionList.length === 0) {
          await sendHtml(chatId, formatSystem('No session list cached. Run /sessions first.'));
          return;
        }
        if (num < 1 || num > lastSessionList.length) {
          await sendHtml(chatId, formatSystem(`Invalid. Pick 1–${lastSessionList.length}.`));
          return;
        }
        const target = lastSessionList[num - 1];
        const displayName = target.projectName || target.sessionId.slice(0, 8);
        try {
          await sendHtml(chatId, formatThinking());
          await bridge.switchSession(target.sessionId, target.projectPath);
          await sendHtml(chatId,
            `✅ <b>Switched to: ${escapeHtml(displayName)}</b><br/>` +
            (target.projectPath ? `📁 <code>${escapeHtml(target.projectPath)}</code><br/>` : '') +
            `Session: <code>${target.sessionId.slice(0, 8)}…</code><br/><br/>` +
            `Send a message to continue working in this session.`
          );
        } catch (err) {
          await sendHtml(chatId, formatSystem(`❌ Switch failed: ${err.message}`));
        }
        break;
      }

      default:
        // Unknown command — treat as regular message
        await handleUserMessage(text);
        break;
    }
  }

  // ─── Message Routing ──────────────────────────────────────────

  async function routeIncomingMessage(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
    } else {
      await handleUserMessage(trimmed);
    }
  }

  // ─── Polling Loop ─────────────────────────────────────────────

  async function pollOnce() {
    try {
      const accessToken = await auth.ensureAuthenticated();
      const data = await fetchMessages(accessToken, chatId, 20);

      if (!data?.value) return;

      // Messages come in descending order (newest first)
      // We need to process oldest-first, so reverse
      const messages = [...data.value].reverse();

      for (const msg of messages) {
        // Skip already-processed messages
        if (processedIds.has(msg.id)) continue;

        // Skip messages posted by the bridge itself (tracked in sentByBridge)
        if (sentByBridge.has(msg.id)) {
          processedIds.add(msg.id);
          continue;
        }

        // In self-chat mode: all messages are from us, so skip bridge-posted ones
        // In normal mode: skip messages from our own user ID (bridge responses)
        const senderId = msg.from?.user?.id;
        if (!isSelfChat) {
          // Normal mode: skip our own messages
          if (!senderId || senderId === myUserId) {
            processedIds.add(msg.id);
            continue;
          }
        }

        // Skip system messages
        if (msg.messageType && msg.messageType !== 'message') {
          processedIds.add(msg.id);
          continue;
        }

        // Skip messages older than our watermark (on first run, skip all existing)
        const msgTime = new Date(msg.createdDateTime);
        if (lastPollTimestamp && msgTime <= lastPollTimestamp) {
          processedIds.add(msg.id);
          continue;
        }

        // Extract text content
        const rawContent = msg.body?.content || '';
        const text = stripHtml(rawContent).trim();
        if (!text) {
          processedIds.add(msg.id);
          continue;
        }

        log.info(`Incoming: "${text.slice(0, 60)}…"`);
        processedIds.add(msg.id);

        // Route the message
        await routeIncomingMessage(text);
      }

      // Update watermark
      if (messages.length > 0) {
        const newest = data.value[0]; // first in descending = newest
        lastPollTimestamp = new Date(newest.createdDateTime);
        saveWatermark({
          lastMessageId: newest.id,
          lastTimestamp: lastPollTimestamp.toISOString(),
          processedIds: processedIds.toArray().slice(-200), // persist last 200
        });
      }
    } catch (err) {
      log.error('Poll error:', err.message);
    }
  }

  async function startPolling() {
    pollingActive = true;
    let consecutiveErrors = 0;
    let pollCount = 0;

    log.info(`Polling every ${config.teams.pollIntervalMs}ms`);

    while (pollingActive) {
      try {
        await pollOnce();
        consecutiveErrors = 0;
        pollCount++;
        if (pollCount % 120 === 0) {
          log.info(`Heartbeat — ${pollCount} polls`);
        }
      } catch (err) {
        consecutiveErrors++;
        log.error(`Poll loop error (${consecutiveErrors}):`, err.message);
        if (consecutiveErrors >= 10) {
          log.error('Too many consecutive poll errors. Waiting 60s before retry.');
          await new Promise(r => setTimeout(r, 60000));
          consecutiveErrors = 0;
        }
      }
      await new Promise(r => setTimeout(r, config.teams.pollIntervalMs || 3000));
    }
  }

  // ─── Startup ──────────────────────────────────────────────────

  async function start() {
    log.info('Authenticating with Microsoft Graph…');
    const accessToken = await auth.ensureAuthenticated();

    // Get our identity
    const me = await getMe(accessToken);
    myUserId = me.id;
    auth.setMyUserId(me.id);
    log.info(`Authenticated as: ${me.displayName} (${me.userPrincipalName})`);

    // Determine if self-chat mode
    const recipientUpn = config.teams.recipientUpn;
    isSelfChat = !recipientUpn || recipientUpn === 'me';

    // Ensure chat exists
    if (!chatId) {
      if (isSelfChat) {
        log.info('Self-chat mode — finding your "Message yourself" chat…');
      } else {
        log.info(`Creating/finding chat with ${recipientUpn}…`);
      }
      chatId = await ensureChat(accessToken, {
        recipientUpn,
        chatId: config.teams.chatId,
        myUserId,
      });
      log.info(`Chat ID: ${chatId}`);
      if (isSelfChat) {
        log.info('✅ Self-chat discovered. Send messages to yourself in Teams and the bridge will respond.');
      }
    }

    // Set watermark to now if first run (skip existing messages)
    if (!lastPollTimestamp) {
      lastPollTimestamp = new Date();
      saveWatermark({
        lastMessageId: null,
        lastTimestamp: lastPollTimestamp.toISOString(),
        processedIds: [],
      });
    }

    // Start polling
    startPolling();
  }

  function shutdown() {
    pollingActive = false;
    if (pollTimer) clearTimeout(pollTimer);
  }

  // ─── Bridge events ────────────────────────────────────────────

  bridge.on('queued', async (queueLen) => {
    if (chatId) await sendHtml(chatId, formatSystem(`Message queued (${queueLen} waiting)…`));
  });

  return { start, sendHtml, shutdown, getChatId: () => chatId };
}
