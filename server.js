const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { handleApiRequest, sendJson } = require('./src/server/api');

const DEFAULT_PORT = 4173;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function createAppServer(root = __dirname) {
  const projectRoot = path.resolve(root);

  return http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }

    if (/(^|[\\/])\.env(?:$|[.\\/:-])/i.test(pathname)) {
      response.writeHead(404);
      response.end('Page or asset not found');
      return;
    }

    if (pathname.startsWith('/api/')) {
      handleApiRequest(request, response, url).then((handled) => {
        if (!handled && !response.writableEnded) sendJson(response, 404, { error: 'not_found' });
      }).catch(() => {
        if (!response.writableEnded) sendJson(response, 500, { error: 'internal_error' });
      });
      return;
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }

    let requested = pathname === '/' ? '/index.html' : pathname;
    if (requested === '/admin' || requested === '/admin/') {
      requested = '/admin.html';
    }
    const filePath = path.resolve(projectRoot, `.${requested}`);
    if (filePath !== projectRoot && !filePath.startsWith(projectRoot + path.sep)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error.code === 'ENOENT' ? 'Page or asset not found' : 'Server error');
        return;
      }

      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    });
  });
}

/**
 * Probe the loopback interface before binding the local-only preview server.
 */
function probePortAvailability(port) {
  if (!port) return Promise.resolve(true);
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function listenWithFallback(server, startPort = DEFAULT_PORT, maxAttempts = 30) {
  let candidatePort = Number(startPort);
  let attempts = 0;

  for (;;) {
    const free = await probePortAvailability(candidatePort);
    if (!free) {
      if (candidatePort === 0 || attempts >= maxAttempts) {
        throw new Error(`No free port found starting at ${startPort}.`);
      }
      attempts += 1;
      candidatePort += 1;
      continue;
    }

    try {
      return await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve({ port: server.address().port, attempts });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidatePort, '127.0.0.1');
      });
    } catch (error) {
      if (error.code === 'EADDRINUSE' && candidatePort !== 0 && attempts < maxAttempts) {
        attempts += 1;
        candidatePort += 1;
        continue;
      }
      throw error;
    }
  }
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

if (require.main === module) {
  const preferredPort = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const server = createAppServer();

  listenWithFallback(server, preferredPort)
    .then(({ port, attempts }) => {
      const url = `http://localhost:${port}`;
      process.stdout.write(`LOCOXATL multi-page preview running at ${url}\n`);
      if (attempts > 0) {
        process.stdout.write(`Port ${preferredPort} was already in use. This preview is using port ${port}.\n`);
      }
      // Best-effort database probe: the storefront must keep working without MySQL,
      // and the API reports 503 per request while it stays unconfigured.
      const { isConfigured, checkConnection } = require('./src/server/db');
      if (!isConfigured()) {
        process.stdout.write('MySQL orders API: not configured. Copy .env.example to .env to enable order persistence.\n');
      } else {
        checkConnection()
          .then(async () => {
            process.stdout.write('MySQL orders API: connected.\n');
            try {
              const { runAdditiveMigrations } = require('./src/server/migrate');
              const migration = await runAdditiveMigrations();
              if (migration && migration.addedColumns && migration.addedColumns.length) {
                process.stdout.write(`MySQL migrations: applied additive columns (${migration.addedColumns.join(', ')}).\n`);
              }
              const { seedAdminUser } = require('./src/server/auth');
              await seedAdminUser();
            } catch (err) {
              process.stdout.write(`MySQL initialization note: ${err.message}\n`);
            }
          })
          .catch((error) => process.stdout.write(`MySQL orders API: connection failed (${error.message}).\n`));
      }
      if (process.env.OPEN_BROWSER === '1') openBrowser(url);
    })
    .catch((error) => {
      process.stderr.write(`Unable to start LOCOXATL preview: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { createAppServer, listenWithFallback };