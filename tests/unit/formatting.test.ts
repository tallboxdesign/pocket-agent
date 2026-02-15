/**
 * Unit tests for Telegram formatting utilities
 *
 * Tests markdown-to-HTML conversion, message splitting, and chunked response formatting
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  markdownToTelegramHtml,
  splitMessage,
  formatChunkedResponse,
} from '../../src/channels/telegram/formatting';

describe('Telegram Formatting', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ============ markdownToTelegramHtml ============

  describe('markdownToTelegramHtml', () => {
    describe('inline formatting', () => {
      it('should convert bold **text** to <b>text</b>', () => {
        expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
      });

      it('should convert bold with surrounding text', () => {
        expect(markdownToTelegramHtml('this is **bold** text')).toBe(
          'this is <b>bold</b> text'
        );
      });

      it('should convert italic *text* to <i>text</i>', () => {
        expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>');
      });

      it('should convert italic with surrounding text', () => {
        expect(markdownToTelegramHtml('this is *italic* text')).toBe(
          'this is <i>italic</i> text'
        );
      });

      it('should convert strikethrough ~~text~~ to <s>text</s>', () => {
        expect(markdownToTelegramHtml('~~strike~~')).toBe('<s>strike</s>');
      });

      it('should convert strikethrough with surrounding text', () => {
        expect(markdownToTelegramHtml('this is ~~struck~~ text')).toBe(
          'this is <s>struck</s> text'
        );
      });

      it('should convert inline code `code` to <code>code</code>', () => {
        expect(markdownToTelegramHtml('use `code` here')).toBe(
          'use <code>code</code> here'
        );
      });

      it('should handle multiple inline formats in one line', () => {
        const result = markdownToTelegramHtml('**bold** and *italic* and ~~strike~~');
        expect(result).toContain('<b>bold</b>');
        expect(result).toContain('<i>italic</i>');
        expect(result).toContain('<s>strike</s>');
      });
    });

    describe('code blocks', () => {
      it('should convert fenced code blocks to <pre> tags', () => {
        const input = '```js\nconsole.log("hi")\n```';
        const result = markdownToTelegramHtml(input);
        // The code escapes &, <, > but not double quotes
        expect(result).toContain('<pre>console.log("hi")</pre>');
      });

      it('should convert code blocks without language specifier', () => {
        const input = '```\nhello world\n```';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('<pre>hello world</pre>');
      });

      it('should not double-escape HTML inside code blocks', () => {
        const input = '```\n<div>test</div>\n```';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('<pre>&lt;div&gt;test&lt;/div&gt;</pre>');
        // Should not have &amp;lt; (double-escaped)
        expect(result).not.toContain('&amp;lt;');
      });

      it('should not double-escape HTML inside inline code', () => {
        const input = '`<script>`';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('<code>&lt;script&gt;</code>');
        expect(result).not.toContain('&amp;lt;');
      });
    });

    describe('links', () => {
      it('should convert markdown links to HTML anchor tags', () => {
        const result = markdownToTelegramHtml('[Google](https://google.com)');
        expect(result).toBe('<a href="https://google.com">Google</a>');
      });

      it('should handle links with surrounding text', () => {
        const result = markdownToTelegramHtml('visit [here](https://example.com) now');
        expect(result).toContain('<a href="https://example.com">here</a>');
      });
    });

    describe('headers', () => {
      it('should convert # header to bold', () => {
        expect(markdownToTelegramHtml('# Header')).toBe('<b>Header</b>');
      });

      it('should convert ## header to bold', () => {
        expect(markdownToTelegramHtml('## Sub Header')).toBe('<b>Sub Header</b>');
      });

      it('should convert ### header to bold', () => {
        expect(markdownToTelegramHtml('### Deep Header')).toBe('<b>Deep Header</b>');
      });
    });

    describe('lists', () => {
      it('should convert unordered list items with dash', () => {
        expect(markdownToTelegramHtml('- item one')).toBe('• item one');
      });

      it('should convert unordered list items with asterisk', () => {
        expect(markdownToTelegramHtml('* item one')).toBe('• item one');
      });

      it('should convert ordered list items', () => {
        expect(markdownToTelegramHtml('1. first item')).toBe('1. first item');
      });

      it('should convert multiple ordered list items', () => {
        const input = '1. first\n2. second\n3. third';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('1. first');
        expect(result).toContain('2. second');
        expect(result).toContain('3. third');
      });
    });

    describe('blockquotes', () => {
      it('should convert blockquote to bar + italic', () => {
        const result = markdownToTelegramHtml('> quoted text');
        expect(result).toBe('│ <i>quoted text</i>');
      });

      it('should handle multiple blockquote lines', () => {
        const input = '> line one\n> line two';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('│ <i>line one</i>');
        expect(result).toContain('│ <i>line two</i>');
      });
    });

    describe('checkboxes', () => {
      it('should convert unchecked checkbox', () => {
        const result = markdownToTelegramHtml('- [ ] unchecked task');
        expect(result).toBe('☐ unchecked task');
      });

      it('should convert checked checkbox', () => {
        const result = markdownToTelegramHtml('- [x] checked task');
        expect(result).toBe('☑ checked task');
      });

      it('should convert checked checkbox with uppercase X', () => {
        const result = markdownToTelegramHtml('- [X] checked task');
        expect(result).toBe('☑ checked task');
      });
    });

    describe('tables', () => {
      it('should convert pipe-delimited table to <pre> block', () => {
        const input = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('<pre>');
        expect(result).toContain('</pre>');
        expect(result).toContain('Name');
        expect(result).toContain('Alice');
      });

      it('should skip separator rows in tables', () => {
        const input = '| A | B |\n|---|---|\n| 1 | 2 |';
        const result = markdownToTelegramHtml(input);
        // Separator row should not appear in output
        expect(result).not.toContain('---');
      });
    });

    describe('horizontal rules', () => {
      it('should convert --- to horizontal line', () => {
        expect(markdownToTelegramHtml('---')).toBe('─────────');
      });

      it('should convert *** to horizontal line', () => {
        expect(markdownToTelegramHtml('***')).toBe('─────────');
      });

      it('should convert ___ to horizontal line', () => {
        expect(markdownToTelegramHtml('___')).toBe('─────────');
      });
    });

    describe('HTML escaping', () => {
      it('should escape < and > in regular text', () => {
        const result = markdownToTelegramHtml('<script>alert("xss")</script>');
        expect(result).toContain('&lt;script&gt;');
        expect(result).toContain('&lt;/script&gt;');
        expect(result).not.toContain('<script>');
      });

      it('should escape & in regular text', () => {
        const result = markdownToTelegramHtml('A & B');
        expect(result).toContain('&amp;');
      });
    });

    describe('combined formatting', () => {
      it('should handle multiline mixed content', () => {
        const input = '# Title\n\n**Bold** and *italic*\n\n- list item\n\n> quote';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('<b>Title</b>');
        expect(result).toContain('<b>Bold</b>');
        expect(result).toContain('<i>italic</i>');
        expect(result).toContain('• list item');
        expect(result).toContain('│ <i>quote</i>');
      });

      it('should handle empty string', () => {
        expect(markdownToTelegramHtml('')).toBe('');
      });

      it('should handle plain text with no formatting', () => {
        expect(markdownToTelegramHtml('hello world')).toBe('hello world');
      });
    });
  });

  // ============ splitMessage ============

  describe('splitMessage', () => {
    it('should return single chunk for short text', () => {
      const result = splitMessage('short message');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('short message');
    });

    it('should return single chunk when exactly at maxLength', () => {
      const text = 'a'.repeat(100);
      const result = splitMessage(text, 100);
      expect(result).toHaveLength(1);
    });

    it('should split at paragraph boundary (double newline)', () => {
      const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60);
      const result = splitMessage(text, 100);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0]).toContain('a');
      expect(result[result.length - 1]).toContain('b');
    });

    it('should split at newline when no paragraph break available', () => {
      const text = 'a'.repeat(60) + '\n' + 'b'.repeat(60);
      const result = splitMessage(text, 100);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should split at sentence boundary when no newline available', () => {
      const text = 'a'.repeat(50) + '. ' + 'b'.repeat(60);
      const result = splitMessage(text, 100);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should split at space when no sentence boundary available', () => {
      const text = 'word '.repeat(25); // ~125 chars
      const result = splitMessage(text, 100);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should hard cut when no space available', () => {
      const text = 'a'.repeat(200);
      const result = splitMessage(text, 100);
      expect(result.length).toBe(2);
      expect(result[0]).toHaveLength(100);
      expect(result[1]).toHaveLength(100);
    });

    it('should handle empty string', () => {
      const result = splitMessage('');
      expect(result).toHaveLength(0);
    });

    it('should use default maxLength of 4000', () => {
      const text = 'a'.repeat(3999);
      const result = splitMessage(text);
      expect(result).toHaveLength(1);
    });
  });

  // ============ formatChunkedResponse ============

  describe('formatChunkedResponse', () => {
    it('should return single chunk without prefix for short text', () => {
      const result = formatChunkedResponse('hello **world**');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('hello <b>world</b>');
      // No (1/1) prefix for single chunk
      expect(result[0]).not.toContain('(1/');
    });

    it('should add (N/Total) prefix for multi-chunk messages', () => {
      const longText = 'paragraph one\n\nparagraph two\n\nparagraph three';
      const result = formatChunkedResponse(longText, 30);
      expect(result.length).toBeGreaterThan(1);
      expect(result[0]).toContain(`(1/${result.length})`);
      expect(result[1]).toContain(`(2/${result.length})`);
    });

    it('should apply HTML conversion to each chunk', () => {
      const longText = '**bold first**\n\n*italic second*';
      const result = formatChunkedResponse(longText, 20);
      // The chunks should contain HTML-converted content
      const combined = result.join(' ');
      expect(combined).toContain('<b>');
      expect(combined).toContain('<i>');
    });

    it('should use default maxLength of 4000', () => {
      const shortText = 'hello world';
      const result = formatChunkedResponse(shortText);
      expect(result).toHaveLength(1);
    });
  });
});
