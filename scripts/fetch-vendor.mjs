import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const quillVersion = '2.0.3';
const markdownVersion = '15.0.3';
const quillFiles = [
  { name: 'quill.js', source: `https://cdn.jsdelivr.net/npm/quill@${quillVersion}/dist/quill.js` },
  { name: 'quill.snow.css', source: `https://cdn.jsdelivr.net/npm/quill@${quillVersion}/dist/quill.snow.css` },
  { name: 'LICENSE', source: `https://cdn.jsdelivr.net/npm/quill@${quillVersion}/LICENSE` },
];
const markdownFiles = [
  { name: 'markdown-it.min.js', source: `https://cdn.jsdelivr.net/npm/markdown-it@${markdownVersion}/dist/browser/markdown-it.umd.min.js` },
  { name: 'MARKDOWN-IT-LICENSE', source: `https://cdn.jsdelivr.net/npm/markdown-it@${markdownVersion}/LICENSE` },
];
const files = [...quillFiles, ...markdownFiles];
const manifestFile = resolve(vendorRoot, 'SHA256SUMS');
let expected = new Map();
try {
  const manifest = await readFile(manifestFile, 'utf8');
  expected = new Map(manifest.trim().split('\n').map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) throw new Error('SHA256SUMS 的格式无效。');
    return [match[2], match[1]];
  }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const downloads = await Promise.all(files.map(async (file) => {
  const response = await fetch(file.source, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`${file.name} 下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (expected.has(file.name) && expected.get(file.name) !== hash) {
    throw new Error(`${file.name} 与已固定的 SHA256 不一致，文件未被替换。`);
  }
  if (!bytes.length) throw new Error(`${file.name} 是空文件。`);
  return { ...file, bytes, hash };
}));

await mkdir(vendorRoot, { recursive: true });
for (const file of downloads) {
  await writeFile(resolve(vendorRoot, file.name), file.bytes);
  console.log(`${file.name}: ${file.bytes.length} bytes, SHA256 ${file.hash}`);
}
await writeFile(manifestFile, downloads.map((file) => `${file.hash}  ${file.name}\n`).join(''));
await writeFile(resolve(vendorRoot, 'SOURCE.md'), '# 第三方资源\n\n' +
  '以下文件取自 jsDelivr 的 npm 分发，随网站一同保存。运行 `node scripts/fetch-vendor.mjs` 可恢复资源，下载结果会与 `SHA256SUMS` 中的记录核对。\n\n' +
  `## Quill ${quillVersion}\n\n` +
  quillFiles.map((file) => `- ${file.name}: ${file.source}`).join('\n') + '\n\n' +
  '[官方网站](https://quilljs.com/) · BSD-3-Clause，见本目录 `LICENSE`。\n\n' +
  `## markdown-it ${markdownVersion}\n\n` +
  markdownFiles.map((file) => `- ${file.name}: ${file.source}`).join('\n') + '\n\n' +
  `[npm 版本信息](https://registry.npmjs.org/markdown-it/${markdownVersion}) · MIT，见本目录 \`MARKDOWN-IT-LICENSE\`。\n`);
