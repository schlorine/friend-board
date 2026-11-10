import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep, isAbsolute } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(projectRoot);
const port = Number(process.env.PORT || process.argv[2] || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('端口必须是 1–65535 之间的整数。');
}

// Local preview intentionally exposes only the files needed by the website.
const publicFiles = new Set([
  'index.html', 'styles.css', 'config.json', 'favicon.svg', 'data/board.json',
  'scripts/app.js', 'scripts/model.js', 'scripts/github.js',
  'vendor/quill.js', 'vendor/quill.snow.css',
  'tests/viewport.html',
]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function respond(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return respond(response, 405, 'Method not allowed');
  }

  try {
    // Inspect the raw path before URL normalization can remove traversal segments.
    const rawPath = (request.url || '/').split(/[?#]/, 1)[0];
    const pathname = decodeURIComponent(rawPath);
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')
      || pathname.split('/').some((part) => part === '..' || part === '.')) {
      return respond(response, 400, 'Invalid path');
    }
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!publicFiles.has(filename)) return respond(response, 404, 'Not found');

    const target = await realpath(resolve(root, filename));
    const localPath = relative(root, target);
    if (isAbsolute(localPath) || localPath.startsWith(`..${sep}`) || localPath === '..'
      || resolve(root, localPath) !== target) {
      return respond(response, 403, 'Forbidden');
    }
    const bytes = await readFile(target);
    const extension = filename.slice(filename.lastIndexOf('.'));
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Content-Length': bytes.length,
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    if (error instanceof URIError) return respond(response, 400, 'Invalid path');
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return respond(response, 404, 'Not found');
    respond(response, 500, 'Preview error');
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被占用。请尝试 node scripts/serve.mjs ${port + 1}`
    : `无法启动预览：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${port}/`);
  console.log('按 Ctrl+C 结束本地预览。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
