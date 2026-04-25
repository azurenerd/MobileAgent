import { Bot, InputFile } from 'grammy';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';
import { config } from './config.js';
import { formatRelativeTime } from './sessions.js';
import { MODE_LABELS } from './bridge.js';
import {
  formatAssistant,
  formatToolActivity,
  formatSystem,
  formatThinking,
  chunkMessage,
  escapeHtml,
} from './formatter.js';

/**
 * Create and configure the Telegram bot with grammY.
 * Wires message handlers to the CopilotBridge.
 */
export function createTelegramBot(bridge) {
  const bot = new Bot(config.telegram.botToken);

  // ─── Auth middleware: only allow the authorized user ─────────────
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.telegram.userId) {
      return; // silently reject
    }
    await next();
  });

  // ─── Helper: send HTML message with chunking ────────────────────
  async function sendHtml(chatId, text) {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        // Fallback: send as plain text
        console.warn('[telegram] HTML send failed, trying plain:', err.message);
        try {
          await bot.api.sendMessage(chatId, chunk);
        } catch (err2) {
          console.error('[telegram] Plain send also failed:', err2.message);
        }
      }
    }
  }

  // ─── Helper: edit a message with HTML, fallback to new message ──
  async function editMessage(chatId, messageId, text) {
    const chunks = chunkMessage(text);
    try {
      await bot.api.editMessageText(chatId, messageId, chunks[0], {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      // Send overflow chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await bot.api.sendMessage(chatId, chunks[i], {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      }
    } catch (err) {
      // If edit fails (e.g. message too old), send as new
      console.warn('[telegram] Edit failed, sending new:', err.message);
      await sendHtml(chatId, text);
    }
  }

  // ─── Helper: typing indicator loop ──────────────────────────────
  function startTyping(chatId) {
    const send = () => bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    send();
    const interval = setInterval(send, 4000);
    return () => clearInterval(interval);
  }

  // ─── Core: process a user message through Copilot ───────────────
  async function handleUserMessage(ctx, text, imagePaths = []) {
    const chatId = ctx.chat.id;
    const userMsgId = ctx.message.message_id;
    const startTime = Date.now();

    // Send thinking indicator
    let statusMsg;
    try {
      statusMsg = await ctx.reply(formatThinking(), {
        parse_mode: 'HTML',
      });
    } catch {
      statusMsg = null;
    }

    const stopTyping = startTyping(chatId);

    // Track tool activity for live updates
    let lastToolUpdate = 0;
    let toolsUsed = [];
    const onToolStart = async (toolName) => {
      toolsUsed.push(toolName);
      const now = Date.now();
      if (statusMsg && now - lastToolUpdate > 2000) {
        lastToolUpdate = now;
        try {
          await bot.api.editMessageText(
            chatId, statusMsg.message_id,
            formatToolActivity(toolName),
            { parse_mode: 'HTML' }
          );
        } catch {}
      }
    };

    // Periodic progress updates every 30s during long operations
    let progressInterval = null;
    if (statusMsg) {
      progressInterval = setInterval(async () => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const toolInfo = toolsUsed.length > 0
          ? `\nTools: ${toolsUsed.slice(-3).join(', ')}${toolsUsed.length > 3 ? ` (+${toolsUsed.length - 3} more)` : ''}`
          : '';
        try {
          await bot.api.editMessageText(
            chatId, statusMsg.message_id,
            `🔄 <i>Working… (${elapsed}s elapsed)${toolInfo}</i>`,
            { parse_mode: 'HTML' }
          );
        } catch {}
      }, 30000);
    }

    bridge.on('tool_start', onToolStart);

    try {
      const result = await bridge.sendMessage(text, imagePaths);
      stopTyping();
      bridge.off('tool_start', onToolStart);
      if (progressInterval) clearInterval(progressInterval);

      // Format the response in CLI style
      const formatted = formatAssistant(result.text);
      if (formatted && statusMsg) {
        await editMessage(chatId, statusMsg.message_id, formatted);
      } else if (formatted) {
        await sendHtml(chatId, formatted);
      } else if (statusMsg) {
        await editMessage(chatId, statusMsg.message_id, formatSystem('(empty response)'));
      }
    } catch (err) {
      stopTyping();
      bridge.off('tool_start', onToolStart);
      if (progressInterval) clearInterval(progressInterval);

      const errText = formatSystem(`❌ Error: ${err.message}`);
      if (statusMsg) {
        await editMessage(chatId, statusMsg.message_id, errText);
      } else {
        await sendHtml(chatId, errText);
      }
    }
  }

  // ─── Helper: download Telegram file to local temp dir ───────────
  async function downloadTelegramFile(fileId) {
    bridge.ensureTempDir();
    const file = await bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    const ext = file.file_path.split('.').pop() || 'jpg';
    const localPath = join(config.tempDir, `${fileId}.${ext}`);

    await new Promise((resolve, reject) => {
      const client = fileUrl.startsWith('https') ? https : http;
      client.get(fileUrl, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          writeFileSync(localPath, Buffer.concat(chunks));
          resolve();
        });
        res.on('error', reject);
      }).on('error', reject);
    });

    return localPath;
  }

  // ─── Bot commands ───────────────────────────────────────────────

  bot.command('start', (ctx) => ctx.reply(
    `🟣 <b>Copilot Mobile Assistant v3</b>\n\n` +
    `Powered by the GitHub Copilot SDK.\n` +
    `Send any message to chat with Copilot.\n\n` +
    `<b>Modes:</b>\n` +
    `  /agent — Full autonomy (execute tools)\n` +
    `  /ask — Read-only (answers only)\n` +
    `  /plan — Suggest-only (no execution)\n\n` +
    `<b>Commands:</b>\n` +
    `  /sessions — List active CLI sessions\n` +
    `  /switch &lt;n&gt; — Switch to session N\n` +
    `  /screenshot — Capture &amp; send screen\n` +
    `  /status — Bridge &amp; session info\n` +
    `  /new — Start a new conversation\n` +
    `  /help — Show this help`,
    { parse_mode: 'HTML' }
  ));

  bot.command('help', (ctx) => ctx.reply(
    `<b>Modes:</b>\n` +
    `  /agent — 🤖 Full autonomy (run commands, write files)\n` +
    `  /ask — 💬 Read-only (answer questions)\n` +
    `  /plan — 📋 Suggest-only (describe, don't execute)\n\n` +
    `<b>Sessions:</b>\n` +
    `  /sessions — List active CLI terminal sessions\n` +
    `  /switch &lt;n&gt; — Connect to session N\n` +
    `  /new — Fresh conversation\n\n` +
    `<b>Other:</b>\n` +
    `  /screenshot — 📸 Auto-detect &amp; capture running app\n` +
    `  /screenshot &lt;url&gt; — Capture a specific URL\n` +
    `  /screenshot desktop — Raw desktop capture\n` +
    `  /status — Session info, mode &amp; uptime\n` +
    `  /cancel — Cancel current request\n` +
    `  /model — Current model\n` +
    `  /model &lt;name&gt; — Switch model\n\n` +
    `<b>Tips:</b>\n` +
    `  • Send a photo for image analysis\n` +
    `  • /sessions to see your open terminals\n` +
    `  • /agent before asking it to do work`,
    { parse_mode: 'HTML' }
  ));

  bot.command('status', async (ctx) => {
    const s = bridge.getStatus();
    const emoji = s.state === 'idle' ? '🟢' : '⏳';
    await ctx.reply(
      `${emoji} <b>Bridge Status</b>\n\n` +
      `State: <code>${s.state}</code>\n` +
      `Mode: ${s.modeLabel}\n` +
      `Session: <code>${s.sessionId ? s.sessionId.slice(0, 8) + '…' : 'none'}</code>\n` +
      `Model: <code>${s.model}</code>\n` +
      `Queue: <code>${s.queueLength}</code>\n` +
      `Requests: <code>${s.requestCount}</code>\n` +
      `Uptime: <code>${formatUptime(s.uptimeSeconds)}</code>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('cancel', async (ctx) => {
    await bridge.cancel();
    await ctx.reply(formatSystem('Cancelled. Queue cleared.'), { parse_mode: 'HTML' });
  });

  bot.command('new', async (ctx) => {
    try {
      const newId = await bridge.newSession();
      await ctx.reply(
        formatSystem(`New session: ${newId.slice(0, 8)}…\nConversation memory reset.`),
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(
        formatSystem(`❌ Failed to create session: ${err.message}`),
        { parse_mode: 'HTML' }
      );
    }
  });

  bot.command('model', async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg) {
      config.copilot.model = arg;
      await ctx.reply(formatSystem(`Model switched to: ${arg}`), { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        formatSystem(`Current model: ${config.copilot.model}`),
        { parse_mode: 'HTML' }
      );
    }
  });

  bot.command('models', async (ctx) => {
    try {
      const models = await bridge.listModels();
      if (models.length === 0) {
        await ctx.reply(formatSystem('No models available.'), { parse_mode: 'HTML' });
        return;
      }
      const lines = models.map(m =>
        m.id === config.copilot.model ? `• <b>${escapeHtml(m.id)}</b> ← current` : `• ${escapeHtml(m.id)}`
      );
      await sendHtml(ctx.chat.id, lines.join('\n'));
    } catch (err) {
      await ctx.reply(formatSystem(`Failed: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  // ─── Permission mode commands ───────────────────────────────────

  bot.command('agent', async (ctx) => {
    try {
      await bridge.setMode('agent');
      const s = bridge.getStatus();
      await ctx.reply(
        `🤖 <b>Agent Mode</b>\n\n` +
        `Full autonomy enabled. Copilot can:\n` +
        `• Execute shell commands\n` +
        `• Read and write files\n` +
        `• Run tools automatically\n\n` +
        `New session: <code>${s.sessionId?.slice(0, 8) || '?'}…</code>\n` +
        `All permissions granted (autopilot).`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(formatSystem(`❌ Mode switch failed: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  bot.command('ask', async (ctx) => {
    try {
      await bridge.setMode('ask');
      await ctx.reply(
        `💬 <b>Ask Mode</b>\n\n` +
        `Read-only mode. Copilot can:\n` +
        `• Read files for context\n` +
        `• Answer questions\n` +
        `• ❌ Cannot execute commands or write files\n\n` +
        `Session reconnected with ask permissions.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(formatSystem(`❌ Mode switch failed: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  bot.command('plan', async (ctx) => {
    try {
      await bridge.setMode('plan');
      await ctx.reply(
        `📋 <b>Plan Mode</b>\n\n` +
        `Suggest-only mode. Copilot will:\n` +
        `• Describe what it would do\n` +
        `• Suggest commands and changes\n` +
        `• ❌ Cannot execute any tools\n\n` +
        `Switch to /agent to execute plans.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(formatSystem(`❌ Mode switch failed: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  // ─── Screenshot ─────────────────────────────────────────────────

  bot.command('screenshot', async (ctx) => {
    const arg = ctx.match?.trim() || '';
    let statusMsg;

    try {
      // Determine mode from argument
      let label;
      if (arg === 'desktop') {
        label = 'Capturing desktop…';
      } else if (/^https?:\/\//.test(arg)) {
        label = `Capturing ${arg}…`;
      } else {
        label = 'Detecting running app…';
      }

      statusMsg = await ctx.reply(`📸 <i>${escapeHtml(label)}</i>`, { parse_mode: 'HTML' });

      const result = await bridge.captureFeature(arg || null);

      if (result.mode === 'no-server') {
        // No server found — inform user
        await editMessage(ctx.chat.id, statusMsg.message_id,
          `📸 <b>No running web server detected</b>\n\n` +
          `Project: <code>${escapeHtml(result.projectDir || 'unknown')}</code>\n\n` +
          `Try:\n` +
          `• <code>/screenshot http://localhost:3000</code> — specific URL\n` +
          `• <code>/screenshot desktop</code> — raw desktop capture\n` +
          `• Start a dev server first, then retry /screenshot`
        );
        return;
      }

      // Send the screenshot photo
      await bot.api.sendPhoto(ctx.chat.id, new InputFile(result.filePath));
      bridge.cleanupFile(result.filePath);

      // Add caption about what was captured
      let caption = '';
      if (result.mode === 'auto') {
        caption = `🌐 Captured: <code>${escapeHtml(result.url)}</code>`;
      } else if (result.mode === 'url') {
        caption = `🌐 Captured: <code>${escapeHtml(result.url)}</code>`;
      } else if (result.mode === 'desktop-fallback') {
        caption = `🖥️ Desktop fallback (web capture failed for ${escapeHtml(result.url || 'unknown')})`;
      } else {
        caption = `🖥️ Desktop screenshot`;
      }

      // Remove "capturing" message and send caption
      if (statusMsg) {
        try { await bot.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
      }
      await ctx.reply(caption, { parse_mode: 'HTML' });
    } catch (err) {
      const errText = formatSystem(`❌ Screenshot failed: ${err.message}`);
      if (statusMsg) {
        await editMessage(ctx.chat.id, statusMsg.message_id, errText);
      } else {
        await ctx.reply(errText, { parse_mode: 'HTML' });
      }
    }
  });

  // ─── Session discovery + switching ──────────────────────────────

  // Store last session list for /switch reference
  let lastSessionList = [];

  bot.command('sessions', async (ctx) => {
    try {
      const sessions = bridge.listActiveSessions();
      lastSessionList = sessions;

      if (sessions.length === 0) {
        await ctx.reply(
          formatSystem('No active Copilot CLI sessions found.\nOpen a terminal and start a Copilot session first.'),
          { parse_mode: 'HTML' }
        );
        return;
      }

      const currentId = bridge.getStatus().sessionId;
      const lines = ['🔍 <b>Active Copilot Sessions:</b>\n'];

      sessions.forEach((s, i) => {
        const num = `${i + 1}️⃣`;
        const isCurrent = s.sessionId === currentId;
        const marker = isCurrent ? ' ✅ <i>connected</i>' : '';
        const name = s.projectName || s.sessionId.slice(0, 8);
        const path = s.projectPath ? `\n     📁 <code>${escapeHtml(s.projectPath)}</code>` : '';
        const summary = s.summary ? `\n     💬 <i>${escapeHtml(s.summary.slice(0, 60))}</i>` : '';
        const time = s.lastActive ? `\n     🕐 ${formatRelativeTime(s.lastActive)}` : '';

        lines.push(`${num} <b>${escapeHtml(name)}</b>${marker}${path}${summary}${time}\n`);
      });

      lines.push('Reply <code>/switch N</code> to connect to a session.');
      await sendHtml(ctx.chat.id, lines.join('\n'));
    } catch (err) {
      console.error('[telegram] /sessions error:', err);
      await ctx.reply(formatSystem(`❌ Failed: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  bot.command('switch', async (ctx) => {
    const arg = ctx.match?.trim();
    const num = parseInt(arg, 10);

    if (!arg || isNaN(num)) {
      await ctx.reply(
        formatSystem('Usage: /switch <number>\nRun /sessions first to see the list.'),
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (lastSessionList.length === 0) {
      await ctx.reply(
        formatSystem('No session list cached. Run /sessions first.'),
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (num < 1 || num > lastSessionList.length) {
      await ctx.reply(
        formatSystem(`Invalid. Pick 1–${lastSessionList.length}.`),
        { parse_mode: 'HTML' }
      );
      return;
    }

    const target = lastSessionList[num - 1];
    const displayName = target.projectName || target.sessionId.slice(0, 8);

    try {
      await ctx.reply(formatThinking(), { parse_mode: 'HTML' });
      await bridge.switchSession(target.sessionId, target.projectPath);
      await ctx.reply(
        `✅ <b>Switched to: ${escapeHtml(displayName)}</b>\n` +
        (target.projectPath ? `📁 <code>${escapeHtml(target.projectPath)}</code>\n` : '') +
        `Session: <code>${target.sessionId.slice(0, 8)}…</code>\n\n` +
        `Send a message to continue working in this session.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[telegram] /switch error:', err);
      await ctx.reply(
        formatSystem(`❌ Switch failed: ${err.message}`),
        { parse_mode: 'HTML' }
      );
    }
  });

  // ─── Photo messages → download + analyze ────────────────────────

  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption || 'What is in this image?';

    try {
      const localPath = await downloadTelegramFile(largest.file_id);
      console.log(`[telegram] Downloaded photo: ${localPath}`);
      await handleUserMessage(ctx, caption, [localPath]);
      try { unlinkSync(localPath); } catch {}
    } catch (err) {
      console.error('[telegram] Photo error:', err);
      await ctx.reply(formatSystem(`❌ Photo failed: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  // ─── Text messages → send to Copilot ────────────────────────────

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    await handleUserMessage(ctx, text);
  });

  // ─── Bridge events ─────────────────────────────────────────────

  bridge.on('queued', async (queueLen) => {
    await sendHtml(config.telegram.chatId,
      formatSystem(`Message queued (${queueLen} waiting)…`)
    );
  });

  return { bot, sendHtml };
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
