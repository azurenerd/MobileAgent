/**
 * Teams-specific message formatting.
 *
 * Teams chat supports a subset of HTML: <b>, <i>, <em>, <strong>, <a>,
 * <pre>, <code>, <br/>, <img>. Does NOT support <u>, nested tags in some
 * contexts, or Telegram-specific attributes.
 *
 * Uses <br/> for line breaks (Teams requires explicit breaks).
 *
 * @module teams-formatter
 */

const TEAMS_MAX_LENGTH = 28000; // Teams message limit ~28KB

// ─── HTML escaping ──────────────────────────────────────────────────

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── CLI-style formatted messages ───────────────────────────────────

export function formatAssistant(text) {
  const clean = text.trim();
  if (!clean) return null;
  const html = markdownToTeamsHtml(clean);
  return `🟣 <b>Copilot</b><br/><br/>${html}`;
}

export function formatToolActivity(toolName) {
  return `⚙️ <em>${escapeHtml(toolName)}</em>`;
}

export function formatSystem(text) {
  return `🔵 <em>${escapeHtml(text)}</em>`;
}

export function formatThinking() {
  return '⏳ <em>Working…</em>';
}

export function formatSuccess(text) {
  return `✅ <em>${escapeHtml(text)}</em>`;
}

// ─── Markdown → Teams HTML ──────────────────────────────────────────

function markdownToTeamsHtml(text) {
  const stash = [];
  const stashToken = (s) => { stash.push(s); return `\x00S${stash.length - 1}\x00`; };

  let out = text;

  // Fenced code blocks → <pre><code>
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return stashToken(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
  });

  // Inline code → <code>
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    return stashToken(`<code>${escapeHtml(code)}</code>`);
  });

  // Escape remaining text
  out = escapeHtml(out);

  // Headers → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic *text* or _text_
  out = out.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<em>$1</em>');
  out = out.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<em>$1</em>');

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rules
  out = out.replace(/^[-*_]{3,}\s*$/gm, '');

  // Convert newlines to <br/> (Teams requires explicit breaks)
  out = out.replace(/\n/g, '<br/>');

  // Restore stashed blocks
  out = out.replace(/\x00S(\d+)\x00/g, (_m, i) => stash[+i]);

  // Clean excessive breaks
  out = out.replace(/(<br\/>){3,}/g, '<br/><br/>');

  return out.trim();
}

// ─── Message chunking ───────────────────────────────────────────────

export function chunkMessage(text) {
  if (text.length <= TEAMS_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TEAMS_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, TEAMS_MAX_LENGTH);
    const preOpens = (window.match(/<pre>/gi) || []).length;
    const preCloses = (window.match(/<\/pre>/gi) || []).length;
    const insideCode = preOpens > preCloses;

    let splitAt;
    if (insideCode) {
      splitAt = window.lastIndexOf('<br/>');
      if (splitAt < TEAMS_MAX_LENGTH * 0.2) {
        splitAt = TEAMS_MAX_LENGTH - 20;
      }
    } else {
      splitAt = window.lastIndexOf('<br/><br/>');
      if (splitAt < TEAMS_MAX_LENGTH * 0.3) {
        splitAt = window.lastIndexOf('<br/>');
      }
      if (splitAt < TEAMS_MAX_LENGTH * 0.3) {
        splitAt = TEAMS_MAX_LENGTH;
      }
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^<br\/>/, '');

    if (insideCode) {
      chunk += '</code></pre>';
      remaining = '<pre><code>' + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}
