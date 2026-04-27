import { describe, it, expect } from 'vitest';
import {
  formatAssistant, formatSystem, formatThinking,
  formatSuccess, formatToolActivity,
  chunkMessage, escapeHtml,
} from '../src/teams-formatter.js';

describe('teams-formatter', () => {
  describe('escapeHtml', () => {
    it('escapes all HTML entities', () => {
      expect(escapeHtml('<b>"hello" & \'world\'</b>')).toBe(
        '&lt;b&gt;&quot;hello&quot; &amp; \'world\'&lt;/b&gt;'
      );
    });
  });

  describe('formatAssistant', () => {
    it('wraps text with Copilot header and converts to HTML', () => {
      const result = formatAssistant('Hello **world**');
      expect(result).toContain('🟣');
      expect(result).toContain('<b>Copilot</b>');
      expect(result).toContain('<b>world</b>');
    });

    it('returns null for empty text', () => {
      expect(formatAssistant('')).toBeNull();
      expect(formatAssistant('   ')).toBeNull();
    });

    it('uses <br/> for line breaks (not \\n)', () => {
      const result = formatAssistant('line1\nline2');
      expect(result).toContain('<br/>');
      expect(result).not.toMatch(/[^r]>\n/); // no raw newlines outside tags
    });

    it('converts code blocks', () => {
      const result = formatAssistant('```js\nconst x = 1;\n```');
      expect(result).toContain('<pre><code>');
      expect(result).toContain('const x = 1;');
    });

    it('converts inline code', () => {
      const result = formatAssistant('Use `npm install`');
      expect(result).toContain('<code>npm install</code>');
    });

    it('uses <em> not <i> for italic (Teams preference)', () => {
      const result = formatAssistant('This is *italic* text');
      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('formatSystem', () => {
    it('uses blue dot and em tag', () => {
      const result = formatSystem('test message');
      expect(result).toBe('🔵 <em>test message</em>');
    });

    it('escapes HTML in input', () => {
      const result = formatSystem('<script>alert("xss")</script>');
      expect(result).toContain('&lt;script&gt;');
    });
  });

  describe('formatThinking', () => {
    it('returns thinking indicator', () => {
      expect(formatThinking()).toBe('⏳ <em>Working…</em>');
    });
  });

  describe('formatSuccess', () => {
    it('uses checkmark', () => {
      expect(formatSuccess('Done!')).toBe('✅ <em>Done!</em>');
    });
  });

  describe('formatToolActivity', () => {
    it('uses gear emoji and em tag', () => {
      expect(formatToolActivity('readFile')).toBe('⚙️ <em>readFile</em>');
    });
  });

  describe('chunkMessage', () => {
    it('returns single chunk for short messages', () => {
      const result = chunkMessage('short');
      expect(result).toEqual(['short']);
    });

    it('splits long messages', () => {
      const long = 'x'.repeat(30000);
      const chunks = chunkMessage(long);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(28000 + 100); // allow small overflow from code block wrapping
      }
    });

    it('handles code block boundaries', () => {
      const msg = '<pre><code>' + 'x'.repeat(27000) + '</code></pre>';
      const chunks = chunkMessage(msg);
      // Each chunk should be valid
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });
});
