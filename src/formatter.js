const TELEGRAM_MAX_LENGTH = 4096;

// ─── Telegram HTML escaping ─────────────────────────────────────────

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── CLI-style formatted messages ───────────────────────────────────

/**
 * Format an assistant response in GitHub Copilot CLI style.
 * Uses 🟣 (magenta) header, properly formatted code blocks, and clean layout.
 */
export function formatAssistant(text) {
  const clean = text.trim();
  if (!clean) return null;

  // Convert markdown to Telegram HTML
  const html = markdownToHtml(clean);
  return `🟣 <b>Copilot</b>\n\n${html}`;
}

/**
 * Format a tool activity line (magenta-style, like CLI spinner lines).
 */
export function formatToolActivity(toolName) {
  return `⚙️ <i>${escapeHtml(toolName)}</i>`;
}

/**
 * Format a system/status message.
 */
export function formatSystem(text) {
  return `🔵 <i>${escapeHtml(text)}</i>`;
}

/**
 * Format a "thinking" indicator.
 */
export function formatThinking() {
  return '⏳ <i>Working…</i>';
}

/**
 * Format a success/completion message.
 */
export function formatSuccess(text) {
  return `✅ <i>${escapeHtml(text)}</i>`;
}

// ─── Markdown → Telegram HTML conversion ────────────────────────────

/**
 * Convert assistant markdown to Telegram-safe HTML.
 * Handles: code blocks, inline code, bold, italic, headers, links, lists.
 */
function markdownToHtml(text) {
  // Stash code blocks first (protect from further processing)
  const stash = [];
  const stashToken = (s) => { stash.push(s); return `\x00S${stash.length - 1}\x00`; };

  let out = text;

  // Fenced code blocks → <pre><code>
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const langAttr = lang ? ` class="language-${lang}"` : '';
    return stashToken(`<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`);
  });

  // Inline code → <code>
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    return stashToken(`<code>${escapeHtml(code)}</code>`);
  });

  // Now escape the remaining text
  out = escapeHtml(out);

  // Headers → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic *text* or _text_
  out = out.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  out = out.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

  // Links [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rules
  out = out.replace(/^[-*_]{3,}\s*$/gm, '');

  // Restore stashed blocks
  out = out.replace(/\x00S(\d+)\x00/g, (_m, i) => stash[+i]);

  // Clean excessive blank lines
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

// ─── Message chunking ───────────────────────────────────────────────

/**
 * Split a long message into Telegram-safe chunks (≤4096 chars).
 * Respects code block boundaries.
 */
export function chunkMessage(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, TELEGRAM_MAX_LENGTH);

    // Check if we're inside a code block at the split point
    const preOpens = (window.match(/<pre>/gi) || []).length;
    const preCloses = (window.match(/<\/pre>/gi) || []).length;
    const insideCode = preOpens > preCloses;

    let splitAt;
    if (insideCode) {
      // Find last newline to split cleanly inside code
      splitAt = window.lastIndexOf('\n');
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.2) {
        splitAt = TELEGRAM_MAX_LENGTH - 20;
      }
    } else {
      // Prefer paragraph breaks, then newlines
      splitAt = window.lastIndexOf('\n\n');
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
        splitAt = window.lastIndexOf('\n');
      }
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
        splitAt = TELEGRAM_MAX_LENGTH;
      }
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n/, '');

    if (insideCode) {
      chunk += '</code></pre>';
      remaining = '<pre><code>' + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}
