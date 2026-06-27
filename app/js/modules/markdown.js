import { escapeHtml, highlightKeywords } from './utils.js';

export function applyInlineMarkdown(escapedText) {
  let out = String(escapedText || '');
  out = out.replace(
    /!\[([^\]]*)\]\(((?:https?:\/\/|\/|\.\/|\.\.\/)[^\s)]+)\)/g,
    '<img src="$2" alt="$1" loading="lazy">'
  );
  out = out.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|\/|\.\/|\.\.\/|mailto:)[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  return out;
}

export function formatTextBlock(text, keywords = '') {
  const input = String(text || '').trim();
  if (!input) return '';

  const lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks = [];
  const listStack = [];
  let paragraphLines = [];
  let inCodeBlock = false;
  let codeLines = [];

  const expandIndent = (rawLine) => {
    const leading = (rawLine.match(/^\s*/) || [''])[0];
    return leading.replace(/\t/g, '    ').length;
  };

  const parseListLine = (rawLine) => {
    const indent = expandIndent(rawLine);
    const line = rawLine.trimEnd();
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) return { indent, type: 'ul', text: unordered[1].trim() };
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) return { indent, type: 'ol', text: ordered[1].trim() };
    return null;
  };

  const createListBlock = (type, container) => {
    const block = { kind: 'list', type, items: [] };
    container.push(block);
    return block;
  };

  const getCurrentListItem = () => {
    const top = listStack[listStack.length - 1];
    if (!top || top.block.items.length === 0) return null;
    return top.block.items[top.block.items.length - 1];
  };

  const closeListsToIndent = (indent) => {
    while (listStack.length > 0 && indent < listStack[listStack.length - 1].indent) {
      listStack.pop();
    }
  };

  const closeAllLists = () => {
    listStack.length = 0;
  };

  const escapeAndHighlight = (value) => {
    const escaped = escapeHtml(String(value || '').trim());
    if (!keywords) return applyInlineMarkdown(escaped);
    return highlightKeywords(escaped, keywords);
  };

  const renderListBlock = (block) => {
    const itemsHtml = block.items
      .map((item) => {
        const body = item.lines.map(escapeAndHighlight).join('<br>');
        const children = item.children.map(renderListBlock).join('');
        return `<li>${body}${children}</li>`;
      })
      .join('');
    return `<${block.type}>${itemsHtml}</${block.type}>`;
  };

  const isTableDelimiter = (rawLine) =>
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(rawLine || ''));

  const parseTableRow = (rawLine) => {
    const line = String(rawLine || '').trim();
    if (!line || !line.includes('|') || isTableDelimiter(line)) return null;
    let cells = line.split('|').map((cell) => cell.trim());
    if (cells.length > 0 && cells[0] === '') cells = cells.slice(1);
    if (cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    return cells.length >= 2 ? cells : null;
  };

  const renderTableBlock = (headerCells, rowCells) => {
    const columnCount = headerCells.length;
    const headerHtml = headerCells.map((cell) => `<th>${escapeAndHighlight(cell)}</th>`).join('');
    const bodyHtml = rowCells
      .map((row) => {
        const padded = [...row];
        while (padded.length < columnCount) padded.push('');
        const cells = padded.slice(0, columnCount).map((cell) => `<td>${escapeAndHighlight(cell)}</td>`).join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
  };

  const parseQuoteLine = (rawLine) => {
    const match = String(rawLine || '').match(/^\s*>\s?(.*)$/);
    return match ? match[1] : null;
  };

  const renderQuoteBlock = (quoteLines) => {
    const content = quoteLines.map((line) => escapeAndHighlight(line)).join('<br>');
    return `<blockquote><p>${content}</p></blockquote>`;
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${paragraphLines.map(escapeAndHighlight).join('<br>')}</p>`);
    paragraphLines = [];
  };

  const flushCodeBlock = () => {
    if (codeLines.length === 0) {
      blocks.push('<pre><code></code></pre>');
      return;
    }
    const code = codeLines.map((line) => escapeHtml(String(line || ''))).join('\n');
    blocks.push(`<pre><code>${code}</code></pre>`);
    codeLines = [];
  };

  const addListItem = (entry) => {
    closeListsToIndent(entry.indent);

    if (listStack.length > 0 && entry.indent > listStack[listStack.length - 1].indent) {
      const parentItem = getCurrentListItem();
      if (parentItem) {
        const block = createListBlock(entry.type, parentItem.children);
        listStack.push({ indent: entry.indent, type: entry.type, block, container: parentItem.children });
      } else {
        const block = createListBlock(entry.type, blocks);
        listStack.push({ indent: entry.indent, type: entry.type, block, container: blocks });
      }
    } else if (
      listStack.length === 0 ||
      listStack[listStack.length - 1].indent !== entry.indent ||
      listStack[listStack.length - 1].type !== entry.type
    ) {
      if (listStack.length > 0 && listStack[listStack.length - 1].indent === entry.indent) {
        const siblingContainer = listStack[listStack.length - 1].container;
        listStack.pop();
        const block = createListBlock(entry.type, siblingContainer);
        listStack.push({ indent: entry.indent, type: entry.type, block, container: siblingContainer });
      } else {
        const container = listStack.length > 0 ? listStack[listStack.length - 1].container : blocks;
        const block = createListBlock(entry.type, container);
        listStack.push({ indent: entry.indent, type: entry.type, block, container });
      }
    }

    const top = listStack[listStack.length - 1];
    top.block.items.push({ lines: [entry.text], children: [] });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const fenceLine = rawLine.trim();
    if (/^```/.test(fenceLine)) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        flushParagraph();
        closeAllLists();
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const firstQuoteLine = parseQuoteLine(rawLine);
    if (firstQuoteLine !== null) {
      flushParagraph();
      closeAllLists();
      const quoteLines = [firstQuoteLine];
      i += 1;
      while (i < lines.length) {
        const next = parseQuoteLine(lines[i]);
        if (next === null) {
          i -= 1;
          break;
        }
        quoteLines.push(next);
        i += 1;
      }
      blocks.push(renderQuoteBlock(quoteLines));
      continue;
    }

    const headingMatch = rawLine.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeAllLists();
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${escapeAndHighlight(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const headerCells = parseTableRow(rawLine);
    if (headerCells && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      closeAllLists();
      const bodyRows = [];
      i += 2;
      while (i < lines.length) {
        const row = parseTableRow(lines[i]);
        if (!row) {
          i -= 1;
          break;
        }
        bodyRows.push(row);
        i += 1;
      }
      blocks.push(renderTableBlock(headerCells, bodyRows));
      continue;
    }

    const listLine = parseListLine(rawLine);
    if (listLine) {
      flushParagraph();
      addListItem(listLine);
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed === '') {
      flushParagraph();
      continue;
    }

    if (listStack.length > 0) {
      const indent = expandIndent(rawLine);
      const top = listStack[listStack.length - 1];
      if (indent > top.indent) {
        const currentItem = getCurrentListItem();
        if (currentItem) {
          currentItem.lines.push(trimmed);
          continue;
        }
      } else {
        closeAllLists();
      }
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();
  if (inCodeBlock) {
    flushCodeBlock();
  }

  return blocks
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block.kind === 'list') return renderListBlock(block);
      return '';
    })
    .join('');
}
