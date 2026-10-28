import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import health from '../api/health.js';

const root = resolve('public');
const port = Number(process.env.PORT || 3000);

const server = createServer(async (request, response) => {
  if (request.url === '/api/health') {
    const headers = new Headers();
    const result = await health.fetch(request);
    result.headers.forEach((value, key) => headers.set(key, value));
    response.writeHead(result.status, Object.fromEntries(headers));
    response.end(await result.text());
    return;
  }

  if (request.url === '/' || request.url === '/index.html' || request.url === '/app.js') {
    const file = request.url === '/app.js' ? 'app.js' : 'index.html';
    response.writeHead(200, { 'content-type': file === 'app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
    response.end(await readFile(resolve(root, file)));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Kitchen Planner scaffold listening on http://127.0.0.1:${port}\n`);
});
