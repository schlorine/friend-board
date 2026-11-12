import { safeUrl } from './model.js';

const MAX_SOURCE_LENGTH = 100_000;
const MAX_HTML_LENGTH = 200_000;
const BLOCK_FORMATS = new Set(['heading_open', 'ordered_list_open', 'bullet_list_open', 'blockquote_open']);
const INLINE_FORMATS = new Set(['strong_open', 'em_open', 'link_open']);
let parser;

function createParser() {
  if (typeof globalThis.markdownit !== 'function') return null;
  const markdown = globalThis.markdownit({ html: false, linkify: false, breaks: true });
  markdown.disable(['autolink', 'strikethrough', 'table']);
  markdown.validateLink = url => Boolean(safeUrl(url));

  const literalBlock = text => `<p>${markdown.utils.escapeHtml(text).replace(/\n/g, '<br>')}</p>\n`;
  markdown.renderer.rules.literal_heading = (tokens, index) => literalBlock(tokens[index].content);
  markdown.renderer.rules.hr = (tokens, index) => literalBlock(tokens[index].markup);
  // Keep content from unsupported formats as text in a mixed paste.
  for (const type of ['fence', 'code_block']) {
    markdown.renderer.rules[type] = (tokens, index) => literalBlock(tokens[index].content.replace(/\n$/, ''));
  }
  markdown.renderer.rules.code_inline = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
  markdown.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    return markdown.utils.escapeHtml(`![${token.content}](${token.attrGet('src')})`);
  };
  return markdown;
}

function preserveUnsupportedHeadings(tokens, lines) {
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || token.tag === 'h2' || token.tag === 'h3') {
      result.push(token);
      continue;
    }
    // Preserve the source of disallowed headings, including a bare # or a closing #.
    const [start, end] = token.map;
    const line = lines[start];
    const content = token.markup.startsWith('#')
      ? line.slice(line.indexOf(token.markup))
      : lines.slice(start, end).join('\n');
    result.push({ ...token, type: 'literal_heading', tag: '', nesting: 0, content });
    index += 2; // A heading consists of an opener, inline text, and a closer.
  }
  return result;
}

export function markdownClipboardHTML(text) {
  if (typeof text !== 'string' || text.length > MAX_SOURCE_LENGTH || !text.trim()) return null;
  try {
    parser ??= createParser();
    if (!parser) return null;
    const source = text.replace(/\r\n?/g, '\n');
    const environment = {};
    const tokens = preserveUnsupportedHeadings(parser.parse(source, environment), source.split('\n'));
    const hasFormatting = tokens.some(token => BLOCK_FORMATS.has(token.type)
      || token.children?.some(child => INLINE_FORMATS.has(child.type)));
    if (!hasFormatting) return null;
    const html = parser.renderer.render(tokens, parser.options, environment);
    return html.length <= MAX_HTML_LENGTH ? html : null;
  } catch {
    // The editor's regular paste path still receives the complete original text.
    return null;
  }
}
