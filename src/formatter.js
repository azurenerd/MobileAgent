import stripAnsi from 'strip-ansi';

const TELEGRAM_MAX_LENGTH = 4096;
// Reserve space for formatting wrapper (emoji, tags, etc.)
const CONTENT_MAX_LENGTH = TELEGRAM_MAX_LENGTH - 200;

/**
 * Escape text for Telegram HTML parse mode.
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strip ANSI escape codes from terminal output.
 */
export function cleanAnsi(text) {
  return stripAnsi(text);
}

/**
 * Format assistant output for Telegram with purple-style marker.
 * Uses <pre> for monospace and 🟣 emoji for the "purple" feel.
 */
export function formatAssistant(rawText) {
  const clean = cleanAnsi(rawText).trim();
  if (!clean) return null;

  const escaped = escapeHtml(clean);
  return `🟣 <b>Copilot</b>\n<pre>${escaped}</pre>`;
}

/**
 * Format a system/status message (bridge notifications).
 */
export function formatSystem(text) {
  return `🔵 <i>${escapeHtml(text)}</i>`;
}

/**
 * Format the user's own message echo (confirmation of what was sent).
 */
export function formatUserEcho(text) {
  return `🟢 <b>You:</b> <code>${escapeHtml(text)}</code>`;
}

/**
 * Split a long message into Telegram-safe chunks.
 * Tries to split on newlines to avoid breaking mid-line.
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

    // Find a good split point (newline within limit)
    let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    if (splitAt <= 0) {
      // No newline found; hard split at limit
      splitAt = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Clean raw PTY output: strip ANSI, normalize line endings, trim blank lines.
 */
export function cleanOutput(raw) {
  let text = cleanAnsi(raw);
  // Normalize CRLF → LF
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Collapse multiple blank lines into one
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Try to strip the echoed user input from the beginning of PTY output.
 * The PTY echoes what we type, so we strip it to avoid duplication.
 */
export function stripEchoedInput(output, lastInput) {
  if (!lastInput) return output;

  const lines = output.split('\n');
  // The first line(s) often contain the echoed input
  const inputTrimmed = lastInput.trim();

  // Check if the first line contains or matches the sent input
  if (lines.length > 0 && lines[0].includes(inputTrimmed)) {
    lines.shift();
  }

  return lines.join('\n');
}
