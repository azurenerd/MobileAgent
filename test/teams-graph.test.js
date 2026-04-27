import { describe, it, expect } from 'vitest';
import { stripHtml } from '../src/teams-graph.js';

describe('teams-graph', () => {
  describe('stripHtml', () => {
    it('removes HTML tags', () => {
      expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
    });

    it('decodes common entities', () => {
      expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe("& < > \" '");
    });

    it('replaces &nbsp; with space', () => {
      expect(stripHtml('hello&nbsp;world')).toBe('hello world');
    });

    it('handles empty/whitespace', () => {
      expect(stripHtml('  ')).toBe('');
      expect(stripHtml('<br/>')).toBe('');
    });

    it('handles complex Teams HTML', () => {
      const html = '<div><p>Hello</p><p>World</p></div>';
      expect(stripHtml(html)).toBe('HelloWorld');
    });
  });
});
