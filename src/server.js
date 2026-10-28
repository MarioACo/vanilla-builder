// Servidor estático para probar la salida, con recarga automática opcional (modo dev).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.vtt': 'text/vtt; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
};

const RELOAD_SCRIPT = `<script>(()=>{const s=new EventSource('/__builder/events');let box;
s.addEventListener('reload',()=>location.reload());
s.addEventListener('error-build',e=>{box??=document.body.appendChild(Object.assign(document.createElement('pre'),{style:'position:fixed;inset:auto 0 0 0;max-height:50vh;overflow:auto;margin:0;padding:12px;background:#300;color:#fdd;font:12px/1.4 monospace;z-index:2147483647;white-space:pre-wrap'}));box.textContent='Builder: error al compilar\\n\\n'+JSON.parse(e.data)});
s.addEventListener('ok',()=>{box?.remove();box=null});})();</script>`;

/**
 * @param {{dir: string, port?: number, host?: string, liveReload?: boolean}} opts
 */
export function startServer({ dir, port = 5173, host = '127.0.0.1', liveReload = false }) {
  const clients = new Set();
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('URL inválida');
      return;
    }
    if (liveReload && pathname === '/__builder/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    let file = path.join(root, pathname);
    if (path.relative(root, file).startsWith('..')) {
      res.writeHead(403).end('Prohibido');
      return;
    }
    try {
      if (fs.statSync(file).isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.writeHead(301, { Location: `${pathname}/` }).end();
          return;
        }
        file = path.join(file, 'index.html');
      }
    } catch {
      /* se maneja abajo */
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`No encontrado: ${pathname}`);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';
      let body = data;
      if (liveReload && ext.startsWith('.htm')) {
        const html = data.toString('utf8');
        const i = html.toLowerCase().lastIndexOf('</body>');
        body = Buffer.from(i === -1 ? html + RELOAD_SCRIPT : html.slice(0, i) + RELOAD_SCRIPT + html.slice(i));
      }
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
      if (path.basename(file).match(/^sw\.js$|service-?worker/i)) headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers).end(body);
    });
  });
  const send = (event, data = '') => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}/`,
        port: addr.port,
        reload: () => send('reload'),
        buildError: (msg) => send('error-build', msg),
        buildOk: () => send('ok'),
        close: () =>
          new Promise((r) => {
            for (const c of clients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}
