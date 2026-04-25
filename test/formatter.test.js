import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  formatAssistant,
  formatToolActivity,
  formatSystem,
  formatThinking,
  formatSuccess,
  chunkMessage,
} from '../src/formatter.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('handles combined special chars', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('formatAssistant', () => {
  it('wraps text with purple header', () => {
    const result = formatAssistant('Hello world');
    expect(result).toContain('🟣');
    expect(result).toContain('<b>Copilot</b>');
    expect(result).toContain('Hello world');
  });

  it('returns null for empty/whitespace text', () => {
    expect(formatAssistant('')).toBeNull();
    expect(formatAssistant('   ')).toBeNull();
  });

  it('converts markdown code blocks to HTML', () => {
    const result = formatAssistant('```js\nconst x = 1;\n```');
    expect(result).toContain('<pre><code');
    expect(result).toContain('const x = 1;');
  });

  it('converts inline code to HTML', () => {
    const result = formatAssistant('Use `npm install` to install');
    expect(result).toContain('<code>npm install</code>');
  });

  it('converts bold markdown', () => {
    const result = formatAssistant('This is **bold** text');
    expect(result).toContain('<b>bold</b>');
  });
});

describe('formatToolActivity', () => {
  it('wraps tool name with gear emoji', () => {
    expect(formatToolActivity('shell')).toBe('⚙️ <i>shell</i>');
  });

  it('escapes HTML in tool names', () => {
    expect(formatToolActivity('a<b>')).toBe('⚙️ <i>a&lt;b&gt;</i>');
  });
});

describe('formatSystem', () => {
  it('wraps with blue dot and italic', () => {
    const result = formatSystem('hello');
    expect(result).toBe('🔵 <i>hello</i>');
  });

  it('escapes HTML entities', () => {
    expect(formatSystem('a & b')).toContain('&amp;');
  });
});

describe('formatThinking', () => {
  it('returns thinking indicator', () => {
    expect(formatThinking()).toBe('⏳ <i>Working…</i>');
  });
});

describe('formatSuccess', () => {
  it('wraps with check mark', () => {
    const result = formatSuccess('Done');
    expect(result).toContain('✅');
    expect(result).toContain('Done');
  });
});

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = chunkMessage('Hello');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello');
  });

  it('splits long messages at 4096 chars', () => {
    const long = 'a'.repeat(5000);
    const chunks = chunkMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(4096));
  });

  it('preserves all content across chunks', () => {
    const long = Array.from({ length: 500 }, (_, i) => `Line ${i}`).join('\n');
    const chunks = chunkMessage(long);
    const rejoined = chunks.join('\n');
    // All original lines should be present
    expect(rejoined).toContain('Line 0');
    expect(rejoined).toContain('Line 499');
  });

  it('splits inside code blocks with proper close/open tags', () => {
    const code = '<pre><code>' + 'x\n'.repeat(3000) + '</code></pre>';
    const chunks = chunkMessage(code);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end with closing tag
    expect(chunks[0]).toContain('</code></pre>');
    // Second chunk should start with opening tag
    expect(chunks[1]).toMatch(/^<pre><code>/);
  });
});
