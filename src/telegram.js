import { Telegraf } from 'telegraf';
import { config } from './config.js';
import {
  formatAssistant,
  formatSystem,
  formatUserEcho,
  chunkMessage,
  escapeHtml,
} from './formatter.js';

/**
 * Set up the Telegram bot and wire it to the CopilotBridge.
 *
 * Security: only messages from the configured userId/chatId are accepted.
 * All others are silently ignored.
 */
export function createTelegramBot(bridge) {
  const bot = new Telegraf(config.telegram.botToken);

  // ─── Security middleware: reject unauthorized senders ────────────
  bot.use((ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (fromId !== config.telegram.userId || chatId !== config.telegram.chatId) {
      console.log(`[telegram] Rejected message from user=${fromId} chat=${chatId}`);
      return; // silently drop
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
        // If HTML parsing fails, retry as plain text
        if (parseMode === 'HTML') {
          console.warn('[telegram] HTML send failed, retrying plain:', err.message);
          await bot.telegram.sendMessage(config.telegram.chatId, chunk);
        } else {
          console.error('[telegram] Send failed:', err.message);
        }
      }
    }
  }

  // ─── Bridge event handlers ──────────────────────────────────────

  bridge.on('output', async (text) => {
    const formatted = formatAssistant(text);
    if (formatted) {
      await sendToChat(formatted);
    }
  });

  bridge.on('queued', async (text, queueLen) => {
    await sendToChat(formatSystem(`Message queued (${queueLen} in queue). Copilot is still responding...`));
  });

  bridge.on('exit', async (exitCode) => {
    await sendToChat(formatSystem(`⚠️ Copilot CLI exited (code ${exitCode}). Use /reset to restart.`));
  });

  bridge.on('error', async (err) => {
    await sendToChat(formatSystem(`❌ Error: ${err.message}`));
  });

  bridge.on('stateChange', (newState, oldState) => {
    console.log(`[bridge] State: ${oldState} → ${newState}`);
  });

  // ─── Bot commands ───────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    await ctx.reply(
      `🤖 <b>Copilot Telegram Bridge</b>\n\n` +
        `Your Copilot CLI is connected! Send any message to chat with it.\n\n` +
        `<b>Commands:</b>\n` +
        `  /status  — Show bridge status\n` +
        `  /cancel  — Cancel current operation (Ctrl+C)\n` +
        `  /reset   — Restart the CLI process\n` +
        `  /key &lt;name&gt; — Send a key: enter, esc, up, down, left, right, tab, y, n, space, ctrl-c\n` +
        `  /raw     — Send next output as raw unformatted text\n` +
        `  /help    — Show this help message\n`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `<b>Commands:</b>\n` +
        `  /status  — Bridge & CLI status\n` +
        `  /cancel  — Send Ctrl+C to CLI\n` +
        `  /reset   — Kill & restart CLI\n` +
        `  /key &lt;name&gt; — Send key (enter, esc, up, down, y, n, etc.)\n` +
        `  /raw     — Toggle raw output mode\n` +
        `  /queue   — Show queued messages\n\n` +
        `<b>Tips:</b>\n` +
        `  • Just type normally to chat with Copilot\n` +
        `  • Use /key for interactive prompts (menus, confirmations)\n` +
        `  • If Copilot seems stuck, try /cancel then resend\n`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('status', async (ctx) => {
    const s = bridge.getStatus();
    const stateEmoji = {
      idle: '🟢',
      streaming: '⏳',
      starting: '🔄',
      error: '🔴',
      stopped: '⚫',
    };
    const emoji = stateEmoji[s.state] || '❓';

    await ctx.reply(
      `${emoji} <b>Bridge Status</b>\n\n` +
        `State: <code>${s.state}</code>\n` +
        `PID: <code>${s.pid || 'N/A'}</code>\n` +
        `Queue: <code>${s.queueLength} messages</code>\n` +
        `Requests: <code>${s.requestCount}</code>\n` +
        `Uptime: <code>${formatUptime(s.uptimeSeconds)}</code>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('cancel', async (ctx) => {
    bridge.cancel();
    await ctx.reply(formatSystem('Sent Ctrl+C. Queue cleared.'), { parse_mode: 'HTML' });
  });

  bot.command('reset', async (ctx) => {
    await ctx.reply(formatSystem('Restarting Copilot CLI...'), { parse_mode: 'HTML' });
    bridge.reset();
    // Give it a moment to start up
    setTimeout(async () => {
      await sendToChat(formatSystem('✅ Copilot CLI restarted.'));
    }, 3000);
  });

  bot.command('key', async (ctx) => {
    const keyName = ctx.message.text.split(/\s+/)[1];
    if (!keyName) {
      await ctx.reply(
        formatSystem('Usage: /key <name>\nKeys: enter, esc, up, down, left, right, tab, y, n, space, ctrl-c, ctrl-d'),
        { parse_mode: 'HTML' }
      );
      return;
    }

    const sent = bridge.sendKey(keyName);
    if (sent) {
      await ctx.reply(formatSystem(`Sent key: ${keyName}`), { parse_mode: 'HTML' });
    } else {
      await ctx.reply(formatSystem(`Unknown key: ${keyName}`), { parse_mode: 'HTML' });
    }
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

  let rawMode = false;

  bot.command('raw', async (ctx) => {
    rawMode = !rawMode;
    await ctx.reply(
      formatSystem(`Raw output mode: ${rawMode ? 'ON 🔓' : 'OFF 🔒'}`),
      { parse_mode: 'HTML' }
    );

    // If raw mode is on, swap the output handler
    if (rawMode) {
      bridge.removeAllListeners('output');
      bridge.on('output', async (text, raw) => {
        // Send the raw terminal text (still strip ANSI but don't add formatting)
        await sendToChat(`<pre>${escapeHtml(text)}</pre>`);
      });
    } else {
      bridge.removeAllListeners('output');
      bridge.on('output', async (text) => {
        const formatted = formatAssistant(text);
        if (formatted) await sendToChat(formatted);
      });
    }
  });

  // ─── Regular text messages → send to Copilot CLI ────────────────

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // Skip commands (already handled above)
    if (text.startsWith('/')) return;

    // Send to bridge
    const sent = bridge.sendInput(text);
    if (sent) {
      // Confirm what was sent
      await ctx.reply(formatUserEcho(text), { parse_mode: 'HTML' });
    }
    // If queued, the 'queued' event handler will notify
  });

  return bot;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
