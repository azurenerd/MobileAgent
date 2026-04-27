/**
 * Microsoft Graph API helpers for Teams chat operations.
 *
 * Handles: graphFetch with retry, ensureChat, postMessage, fetchMessages.
 * Adapted from Squad framework's comms-teams.ts patterns.
 *
 * @module teams-graph
 */

import { readFileSync } from 'fs';
import { createLogger } from './logger.js';

const log = createLogger('teams-graph');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ─── Graph ID Validation ────────────────────────────────────────────

function validateGraphId(id, label) {
  if (!/^[\w:@.\-]+$/.test(id)) {
    throw new Error(`Invalid ${label}: contains unsafe characters`);
  }
  return encodeURIComponent(id);
}

// ─── Core Fetch with Retry ──────────────────────────────────────────

/**
 * Make a Graph API request with 3-retry exponential backoff for 429/503/504.
 */
export async function graphFetch(url, accessToken, options = {}) {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 429 || res.status === 503 || res.status === 504) {
      if (attempt < maxRetries) {
        const retryAfter = Math.min(Number(res.headers.get('Retry-After') || '5'), 30);
        const jitter = Math.random() * 1000;
        log.warn(`Graph ${res.status}, retry ${attempt + 1}/${maxRetries} in ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + jitter));
        continue;
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph API ${res.status}: ${res.statusText} — ${text}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return undefined;
  }
  throw new Error('Graph API request failed after retries');
}

// ─── User Identity ──────────────────────────────────────────────────

/**
 * Get the current user's Graph profile (id, displayName, mail, userPrincipalName).
 */
export async function getMe(accessToken) {
  return graphFetch(`${GRAPH_BASE}/me`, accessToken);
}

// ─── Chat Operations ────────────────────────────────────────────────

/**
 * Find or create a 1:1 chat with the recipient.
 * If chatId is already known, returns it immediately.
 */
export async function ensureChat(accessToken, { recipientUpn, chatId, myUserId }) {
  if (chatId) return chatId;

  if (!recipientUpn) {
    throw new Error('Teams requires TEAMS_RECIPIENT_UPN or TEAMS_CHAT_ID to be set.');
  }

  const safeUpn = validateGraphId(recipientUpn, 'recipientUpn');
  const chatRes = await graphFetch(`${GRAPH_BASE}/chats`, accessToken, {
    method: 'POST',
    body: {
      chatType: 'oneOnOne',
      members: [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${myUserId}')`,
        },
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${safeUpn}')`,
        },
      ],
    },
  });
  return chatRes.id;
}

// ─── Message Operations ─────────────────────────────────────────────

/**
 * Post an HTML message to a chat.
 * Returns the message object { id, createdDateTime, ... }
 */
export async function postMessage(accessToken, chatId, htmlContent) {
  const safeChatId = validateGraphId(chatId, 'chatId');
  return graphFetch(`${GRAPH_BASE}/chats/${safeChatId}/messages`, accessToken, {
    method: 'POST',
    body: {
      body: {
        contentType: 'html',
        content: htmlContent,
      },
    },
  });
}

/**
 * Post an HTML message with an inline image (hostedContent).
 * The image is base64-encoded and embedded directly in the message.
 */
export async function postMessageWithImage(accessToken, chatId, htmlContent, imagePath, caption = '') {
  const safeChatId = validateGraphId(chatId, 'chatId');
  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  const contentId = `img-${Date.now()}`;

  const fullHtml = caption
    ? `${htmlContent}<br/><img src="../hostedContents/${contentId}/$value" alt="${caption}" />`
    : `<img src="../hostedContents/${contentId}/$value" alt="screenshot" />`;

  return graphFetch(`${GRAPH_BASE}/chats/${safeChatId}/messages`, accessToken, {
    method: 'POST',
    body: {
      body: {
        contentType: 'html',
        content: fullHtml,
      },
      hostedContents: [
        {
          '@microsoft.graph.temporaryId': contentId,
          contentBytes: base64,
          contentType: mimeType,
        },
      ],
    },
  });
}

/**
 * Edit an existing message (PATCH). Returns the updated message or throws.
 */
export async function editMessage(accessToken, chatId, messageId, htmlContent) {
  const safeChatId = validateGraphId(chatId, 'chatId');
  return graphFetch(`${GRAPH_BASE}/chats/${safeChatId}/messages/${messageId}`, accessToken, {
    method: 'PATCH',
    body: {
      body: {
        contentType: 'html',
        content: htmlContent,
      },
    },
  });
}

/**
 * Fetch recent messages from a chat in descending order (newest first).
 * Returns { value: [...messages] }
 */
export async function fetchMessages(accessToken, chatId, top = 20) {
  const safeChatId = validateGraphId(chatId, 'chatId');
  const url = `${GRAPH_BASE}/chats/${safeChatId}/messages?$top=${top}`;
  return graphFetch(url, accessToken);
}

// ─── HTML Helpers ───────────────────────────────────────────────────

export function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
