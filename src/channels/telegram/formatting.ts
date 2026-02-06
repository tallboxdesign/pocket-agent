/**
 * Telegram formatting utilities
 * Converts markdown to Telegram HTML and handles message chunking
 */

/**
 * Convert markdown to Telegram HTML format
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
 * IMPORTANT: Telegram does NOT support nested tags or tables!
 */
export function markdownToTelegramHtml(text: string): string {
  let result = text;

  // Placeholders for protected content
  const protectedContent: string[] = [];

  // Extract and protect code blocks first (```...```)
  // Note: Markers use «» instead of underscores to avoid italic regex matching _N_
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = protectedContent.length;
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim();
    protectedContent.push(`<pre>${escapedCode}</pre>`);
    return `\n@@PROTECTED«${idx}»@@\n`;
  });

  // Extract and protect inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = protectedContent.length;
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    protectedContent.push(`<code>${escapedCode}</code>`);
    return `@@PROTECTED«${idx}»@@`;
  });

  // Extract and protect links [text](url) - before escaping
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const idx = protectedContent.length;
    const escapedText = linkText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    protectedContent.push(`<a href="${url}">${escapedText}</a>`);
    return `@@PROTECTED«${idx}»@@`;
  });

  // Escape HTML in the rest of the text
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Process line by line
  const lines = result.split('\n');
  const processedLines: string[] = [];

  // Collect table rows for batch processing
  let tableRows: string[][] = [];

  for (const line of lines) {
    // Check if this is a table row
    const isTableRow = line.startsWith('|') && line.endsWith('|');
    const isTableSeparator = /^\|[-:\s|]+\|$/.test(line);

    if (isTableRow && !isTableSeparator) {
      // Collect table row
      const cells = line.slice(1, -1).split('|').map(c => stripInlineMarkdown(c.trim()));
      tableRows.push(cells);
      continue;
    } else if (isTableSeparator) {
      // Skip separator rows
      continue;
    } else if (tableRows.length > 0) {
      // End of table - output formatted table
      processedLines.push(formatTable(tableRows));
      tableRows = [];
    }

    // Headers: # ## ### etc -> Bold
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const content = stripInlineMarkdown(headerMatch[2]);
      processedLines.push(`<b>${content}</b>`);
      continue;
    }

    // Blockquotes: > text -> bar + italic
    const quoteMatch = line.match(/^&gt;\s*(.+)$/);
    if (quoteMatch) {
      const content = stripInlineMarkdown(quoteMatch[1]);
      processedLines.push(`│ <i>${content}</i>`);
      continue;
    }

    // Checkboxes: - [ ] or - [x]
    const uncheckedMatch = line.match(/^[-*]\s+\[\s*\]\s+(.+)$/);
    if (uncheckedMatch) {
      processedLines.push(`☐ ${applyInlineFormatting(uncheckedMatch[1])}`);
      continue;
    }
    const checkedMatch = line.match(/^[-*]\s+\[x\]\s+(.+)$/i);
    if (checkedMatch) {
      processedLines.push(`☑ ${applyInlineFormatting(checkedMatch[1])}`);
      continue;
    }

    // Unordered lists: - item or * item -> bullet
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      processedLines.push(`• ${applyInlineFormatting(ulMatch[1])}`);
      continue;
    }

    // Ordered lists: 1. item
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      processedLines.push(`${olMatch[1]}. ${applyInlineFormatting(olMatch[2])}`);
      continue;
    }

    // Horizontal rules: --- or *** or ___
    if (/^[-*_]{3,}$/.test(line)) {
      processedLines.push('─────────');
      continue;
    }

    // Regular line - apply inline formatting
    processedLines.push(applyInlineFormatting(line));
  }

  // Handle any remaining table rows at end of text
  if (tableRows.length > 0) {
    processedLines.push(formatTable(tableRows));
  }

  result = processedLines.join('\n');

  // Restore protected content
  protectedContent.forEach((content, idx) => {
    result = result.replace(`@@PROTECTED«${idx}»@@`, content);
  });

  // Clean up excessive newlines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Format table rows with aligned columns using monospace
 */
function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  // Calculate max width for each column
  const colWidths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, row[i].length);
    }
  }

  // Format each row with padding
  const formattedRows = rows.map(row => {
    const cells = row.map((cell, i) => cell.padEnd(colWidths[i]));
    return cells.join(' │ ');
  });

  // Wrap in <pre> for monospace alignment
  return `<pre>${formattedRows.join('\n')}</pre>`;
}

/**
 * Strip inline markdown formatting (for contexts where we can't nest tags)
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // Remove **bold**
    .replace(/__(.+?)__/g, '$1')       // Remove __bold__
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')  // Remove *italic*
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1')    // Remove _italic_
    .replace(/~~(.+?)~~/g, '$1');      // Remove ~~strike~~
}

/**
 * Apply inline formatting (bold, italic, strikethrough) - one at a time to avoid nesting
 */
function applyInlineFormatting(text: string): string {
  // Process bold first: **text** or __text__
  // We process each match individually to avoid nesting
  let result = text;

  // Bold: **text**
  result = result.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

  // Bold: __text__ (only if not inside a word)
  result = result.replace(/(?<!\w)__([^_]+)__(?!\w)/g, '<b>$1</b>');

  // Italic: *text* (but not **)
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');

  // Italic: _text_ (but not __)
  result = result.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  return result;
}

/**
 * Split long text into chunks at natural boundaries
 */
export function splitMessage(text: string, maxLength: number = 4000): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitPoint = -1;

    // Priority 1: Double newline (paragraph break)
    const doubleNewline = remaining.lastIndexOf('\n\n', maxLength);
    if (doubleNewline > maxLength / 2) {
      splitPoint = doubleNewline;
    }

    // Priority 2: Single newline
    if (splitPoint === -1) {
      const singleNewline = remaining.lastIndexOf('\n', maxLength);
      if (singleNewline > maxLength / 2) {
        splitPoint = singleNewline;
      }
    }

    // Priority 3: Sentence end
    if (splitPoint === -1) {
      const sentenceEnd = Math.max(
        remaining.lastIndexOf('. ', maxLength),
        remaining.lastIndexOf('! ', maxLength),
        remaining.lastIndexOf('? ', maxLength)
      );
      if (sentenceEnd > maxLength / 2) {
        splitPoint = sentenceEnd + 1;
      }
    }

    // Priority 4: Space
    if (splitPoint === -1) {
      const space = remaining.lastIndexOf(' ', maxLength);
      if (space > maxLength / 2) {
        splitPoint = space;
      }
    }

    // Fallback: Hard cut
    if (splitPoint === -1) {
      splitPoint = maxLength;
    }

    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}

/**
 * Format a response with chunk numbering if needed
 */
export function formatChunkedResponse(text: string, maxLength: number = 4000): string[] {
  const chunks = splitMessage(text, maxLength);

  if (chunks.length === 1) {
    return [markdownToTelegramHtml(chunks[0])];
  }

  return chunks.map((chunk, i) => {
    const prefix = `(${i + 1}/${chunks.length}) `;
    return markdownToTelegramHtml(prefix + chunk);
  });
}
