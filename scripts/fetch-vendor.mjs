import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const version = '2.0.3';
const files = [
  { name: 'quill.js', source: `https://cdn.jsdelivr.net/npm/quill@${version}/dist/quill.js` },
  { name: 'quill.snow.css', source: `https://cdn.jsdelivr.net/npm/quill@${version}/dist/quill.snow.css` },
  { name: 'LICENSE', source: `https://cdn.jsdelivr.net/npm/quill@${version}/LICENSE` },
];
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
await writeFile(resolve(vendorRoot, 'SOURCE.md'), `# Quill ${version}\n\n` +
  '来源为 Quill 官方文档所使用的 jsDelivr npm 分发。所有资源已随网站保存，访客无需访问 CDN。\n\n' +
  downloads.map((file) => `- ${file.name}: ${file.source}`).join('\n') + '\n\n' +
  '官方网站：https://quilljs.com/\n\n许可证：BSD-3-Clause，见本目录 LICENSE。\n');
