import { Telegraf } from 'telegraf';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';
import { config } from './config.js';
import {
  formatAssistant,
  formatSystem,
  chunkMessage,
  escapeHtml,
} from './formatter.js';

/**
 * Set up the Telegram bot and wire it to the CopilotBridge (v2 pipe mode).
 */
export function createTelegramBot(bridge) {
  const bot = new Telegraf(config.telegram.botToken);

  // ─── Security middleware: reject unauthorized senders ────────────
  bot.use((ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (fromId !== config.telegram.userId || chatId !== config.telegram.chatId) {
      console.log(`[telegram] Rejected message from user=${fromId} chat=${chatId}`);
      return;
    }
    return next();
  });

  // ─── Helper: send a message to the configured chat ──────────────
  async function sendToChat(text, parseMode = 'HTML') {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      try {
        await bot.telegram.sendMessage(config.telegram.chatId, chunk, {
          parse_mode: parseMode,
          disable_web_page_preview: true,
        });
      } catch (err) {
        if (parseMode === 'HTML') {
          console.warn('[telegram] HTML send failed, retrying plain:', err.message);
          try {
            await bot.telegram.sendMessage(config.telegram.chatId, chunk);
          } catch (err2) {
            console.error('[telegram] Plain send also failed:', err2.message);
          }
        } else {
          console.error('[telegram] Send failed:', err.message);
        }
      }
    }
  }

  // ─── Helper: send thinking indicator, return message for editing ─
  async function sendThinking(ctx) {
    try {
      const msg = await ctx.reply('⏳ Thinking...', { parse_mode: 'HTML' });
      return msg.message_id;
    } catch {
      return null;
    }
  }

  async function editOrSend(ctx, thinkingMsgId, text, parseMode = 'HTML') {
    if (thinkingMsgId) {
      try {
        const chunks = chunkMessage(text);
        // Edit the thinking message with the first chunk
        await bot.telegram.editMessageText(
          config.telegram.chatId,
          thinkingMsgId,
          undefined,
          chunks[0],
          { parse_mode: parseMode, disable_web_page_preview: true }
        );
        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await bot.telegram.sendMessage(config.telegram.chatId, chunks[i], {
            parse_mode: parseMode,
            disable_web_page_preview: true,
          });
        }
        return;
      } catch (err) {
        console.warn('[telegram] Failed to edit thinking msg:', err.message);
      }
    }
    await sendToChat(text, parseMode);
  }

  // ─── Helper: process a message through copilot ──────────────────
  async function handleUserMessage(ctx, text, imagePaths = []) {
    const thinkingMsgId = await sendThinking(ctx);

    try {
      const result = await bridge.sendMessage(text, imagePaths);
      const formatted = formatAssistant(result.text);
      if (formatted) {
        await editOrSend(ctx, thinkingMsgId, formatted);
      } else {
        await editOrSend(ctx, thinkingMsgId, formatSystem('(empty response)'));
      }
    } catch (err) {
      const errMsg = formatSystem(`❌ Error: ${err.message}`);
      await editOrSend(ctx, thinkingMsgId, errMsg);
    }
  }

  // ─── Helper: download a Telegram file to local temp dir ─────────
  async function downloadTelegramFile(fileId) {
    bridge.ensureTempDir();
    const file = await bot.telegram.getFile(fileId);
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

  bot.command('start', async (ctx) => {
    await ctx.reply(
      `🤖 <b>Copilot Telegram Bridge v2</b>\n\n` +
        `Send any message to chat with Copilot CLI.\n` +
        `You can also send photos for image analysis!\n\n` +
        `<b>Commands:</b>\n` +
        `  /status      — Bridge &amp; session status\n` +
        `  /cancel      — Cancel current request\n` +
        `  /newsession  — Start a new conversation\n` +
        `  /session     — Show current session ID\n` +
        `  /help        — Show this help\n`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `<b>Commands:</b>\n` +
        `  /status      — Bridge &amp; session info\n` +
        `  /cancel      — Cancel running request\n` +
        `  /newsession  — Start fresh conversation\n` +
        `  /session     — Current session ID\n` +
        `  /queue       — Show queued messages\n\n` +
        `<b>Tips:</b>\n` +
        `  • Just type to chat with Copilot\n` +
        `  • Send a photo and Copilot will analyze it\n` +
        `  • Add a caption to a photo for specific questions\n` +
        `  • Session persists across messages (conversation memory)\n`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('status', async (ctx) => {
    const s = bridge.getStatus();
    const emoji = s.state === 'idle' ? '🟢' : '⏳';
    await ctx.reply(
      `${emoji} <b>Bridge Status</b>\n\n` +
        `State: <code>${s.state}</code>\n` +
        `Session: <code>${s.sessionId.slice(0, 8)}...</code>\n` +
        `Queue: <code>${s.queueLength}</code>\n` +
        `Requests: <code>${s.requestCount}</code>\n` +
        `Uptime: <code>${formatUptime(s.uptimeSeconds)}</code>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('cancel', async (ctx) => {
    bridge.cancel();
    await ctx.reply(formatSystem('Cancelled current request. Queue cleared.'), { parse_mode: 'HTML' });
  });

  bot.command('newsession', async (ctx) => {
    const newId = bridge.newSession();
    await ctx.reply(
      formatSystem(`New session started: ${newId.slice(0, 8)}...\nConversation memory has been reset.`),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('session', async (ctx) => {
    await ctx.reply(
      formatSystem(`Session ID: ${bridge.getSessionId()}`),
      { parse_mode: 'HTML' }
    );
  });

  bot.command('queue', async (ctx) => {
    const s = bridge.getStatus();
    if (s.queueLength === 0) {
      await ctx.reply(formatSystem('Queue is empty.'), { parse_mode: 'HTML' });
    } else {
      await ctx.reply(
        formatSystem(`${s.queueLength} message(s) queued. Use /cancel to clear.`),
        { parse_mode: 'HTML' }
      );
    }
  });

  // ─── Photo messages → download + send to Copilot ────────────────

  bot.on('photo', async (ctx) => {
    const photos = ctx.message.photo;
    // Telegram sends multiple sizes; take the largest
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption || '';

    try {
      const localPath = await downloadTelegramFile(largest.file_id);
      console.log(`[telegram] Downloaded photo to: ${localPath}`);

      await handleUserMessage(ctx, caption, [localPath]);

      // Clean up temp file
      try { unlinkSync(localPath); } catch {}
    } catch (err) {
      console.error('[telegram] Photo handling error:', err);
      await ctx.reply(formatSystem(`❌ Failed to process photo: ${err.message}`), { parse_mode: 'HTML' });
    }
  });

  // ─── Regular text messages → send to Copilot ───────────────────

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // commands handled above

    await handleUserMessage(ctx, text);
  });

  // ─── Bridge events for queue notifications ─────────────────────

  bridge.on('queued', async (text, queueLen) => {
    await sendToChat(formatSystem(`Message queued (${queueLen} in queue). Waiting for current request...`));
  });

  return { bot, sendToChat };
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
