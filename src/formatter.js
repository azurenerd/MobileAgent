const TELEGRAM_MAX_LENGTH = 4096;

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
 * Format assistant output for Telegram with purple-style marker.
 */
export function formatAssistant(text) {
  const clean = text.trim();
  if (!clean) return null;
  return `🟣 <b>Copilot</b>\n<pre>${escapeHtml(clean)}</pre>`;
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

    let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    if (splitAt <= 0) splitAt = TELEGRAM_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Normalize output: collapse blank lines, trim.
 */
export function cleanOutput(raw) {
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
