import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { markdownClipboardHTML } from '../scripts/markdown.js';

const vendorContext = {};
runInNewContext(readFileSync(new URL('../vendor/markdown-it.min.js', import.meta.url), 'utf8'), vendorContext);
globalThis.markdownit = vendorContext.markdownit;

test('normal prose and literal hash headings use the regular paste path', () => {
  for (const text of ['普通正文', '#', '# 卡片标题', '# **完整保留** #', '这里有一个 # 标签', 'https://example.com', '<https://example.com>', '普通 * 符号']) {
    assert.equal(markdownClipboardHTML(text), null, text);
  }
});

test('H2 and H3 convert while unsupported headings keep their original text', () => {
  const html = markdownClipboardHTML('# 总标题 #\r\n#\r\n## 正文标题\r\n### 小标题\r\n#### 保留原文');
  assert.match(html, /<p># 总标题 #<\/p>/);
  assert.match(html, /<p>#<\/p>/);
  assert.match(html, /<h2>正文标题<\/h2>/);
  assert.match(html, /<h3>小标题<\/h3>/);
  assert.match(html, /<p>#### 保留原文<\/p>/);
  assert.doesNotMatch(html, /<h[14]>/i);
});

test('a literal heading inside a quote keeps its hash without repeating the quote marker', () => {
  const html = markdownClipboardHTML('> # 引用内标题\n>\n> ### 引用小标题');
  assert.match(html, /<blockquote>\s*<p># 引用内标题<\/p>\s*<h3>引用小标题<\/h3>\s*<\/blockquote>/);
});

test('list parsing distinguishes numbered and bulleted items', () => {
  const html = markdownClipboardHTML('1. 第一项\n2. 第二项\n\n- 红色\n- 蓝色');
  assert.match(html, /<ol>\s*<li>第一项<\/li>\s*<li>第二项<\/li>\s*<\/ol>/);
  assert.match(html, /<ul>\s*<li>红色<\/li>\s*<li>蓝色<\/li>\s*<\/ul>/);
});

test('Markdown inline formatting and explicit http(s) links convert', () => {
  const html = markdownClipboardHTML('**加粗** 和 *斜体*，以及 [示例](https://example.com/)。');
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com\/">示例<\/a>/);
});

test('unsupported features alone do not trigger Markdown conversion', () => {
  for (const text of ['```\n## 代码里不是标题\n```', '~~删除线~~', '| A | B |\n| - | - |\n| 1 | 2 |', '<h2>原始 HTML</h2>', '![图片](https://example.com/logo.png)', '[链接](javascript:alert(1))', '[相对路径](./page)']) {
    assert.equal(markdownClipboardHTML(text), null, text);
  }
});

test('mixed pastes keep unsupported content inert and do not create automatic links', () => {
  const html = markdownClipboardHTML('## 标题\n\n<script>alert(1)</script>\n\n![图片](https://example.com/logo.png)\n\nhttps://example.com/\n\n<https://example.org/>\n\n```\n## 代码\n```');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /!\[图片\]\(https:\/\/example\.com\/logo\.png\)/);
  assert.match(html, /<p>## 代码<\/p>/);
  assert.doesNotMatch(html, /<(?:script|img|a)\b/i);
});

test('oversized pastes fall back to the original clipboard text', () => {
  assert.equal(markdownClipboardHTML(`## 标题\n${'字'.repeat(100_000)}`), null);
  assert.equal(markdownClipboardHTML(`## 标题\n${'<'.repeat(60_000)}`), null);
});
