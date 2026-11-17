const { isConfigured, checkConnection } = require('./db');
const {
  createOrder,
  getOrderByNumber,
  updateOrderStatus,
  listOrdersAdmin,
  getOrderDetailAdmin,
  updateOrderStatusAdmin,
  updateOrderAdminNotes,
  getAdminMetrics,
  ValidationError,
  OrderNotFoundError,
  InvalidTransitionError,
} = require('./orders');
const {
  authenticateAdmin,
  validateAdminSession,
  destroyAdminSession,
  extractAdminToken,
  SESSION_TTL_SECONDS,
} = require('./auth');
const cashbook = require('./cashbook');
const { createReportWorkbook, getReportSummary, parseScope } = require('./reports');
const { getPublicConfig } = require('./public-config');

const MAX_BODY_BYTES = 512 * 1024;

async function resolveAdminSession(request) {
  const token = extractAdminToken(request);
  if (!token) return null;
  return validateAdminSession(token);
}

function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(payload);
}

function sendBuffer(response, statusCode, buffer, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(buffer);
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.origin === 'null') return false;

  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = request.socket?.encrypted || forwardedProto === 'https' ? 'https:' : 'http:';
  return originUrl.origin === `${protocol}//${host.toLowerCase()}`;
}

function sessionCookie(token, request, maxAge = SESSION_TTL_SECONDS) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secure = Boolean(request.socket?.encrypted) || forwardedProto === 'https';
  return `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '');
    if (!contentType.toLowerCase().includes('application/json')) {
      const error = new Error('Content-Type must be application/json.');
      error.code = 'UNSUPPORTED_MEDIA_TYPE';
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Request body is too large.');
        error.code = 'PAYLOAD_TOO_LARGE';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('Request body is not valid JSON.');
        error.code = 'INVALID_JSON';
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function databaseUnavailable(response, error) {
  sendJson(response, 503, {
    error: 'database_unavailable',
    message: 'The order could not be stored because the MySQL connection is not available.',
    detail: error.code === 'DB_NOT_CONFIGURED'
      ? `Missing environment variables: ${(error.missing || []).join(', ')}.`
      : 'Check the server database configuration and logs.',
    hint: 'Configure .env from .env.example, import database/schema.sql, then retry.',
  });
}

function mapError(response, error) {
  if (error instanceof ValidationError) {
    sendJson(response, 400, { error: 'validation_error', message: error.message, details: error.details });
    return;
  }
  if (error instanceof OrderNotFoundError) {
    sendJson(response, 404, { error: 'order_not_found', message: error.message });
    return;
  }
  if (error instanceof InvalidTransitionError) {
    sendJson(response, 409, { error: 'invalid_transition', message: error.message });
    return;
  }
  if (error && (error.code === 'DB_NOT_CONFIGURED' || error.code === 'DB_DRIVER_MISSING')) {
    databaseUnavailable(response, error);
    return;
  }
  if (error && (error.code === 'UNSUPPORTED_MEDIA_TYPE' || error.code === 'INVALID_JSON' || error.code === 'PAYLOAD_TOO_LARGE')) {
    const statusCode = error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    sendJson(response, statusCode, { error: error.code.toLowerCase(), message: error.message });
    return;
  }
  if (error && error.statusCode) {
    sendJson(response, error.statusCode, { error: error.code || 'error', message: error.message });
    return;
  }
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ETIMEDOUT')) {
    databaseUnavailable(response, error);
    return;
  }

  // Never leak internals to the browser.
  sendJson(response, 500, { error: 'internal_error', message: 'The order service failed unexpectedly.' });
}

/**
 * Handle /api/* requests. Returns true when the request belongs to the API layer so the
 * static file server can step aside.
 */
async function handleApiRequest(request, response, url) {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return false;

  const segments = pathname.split('/').filter(Boolean); // ['api', 'orders', ':number', 'status']

  try {
    if (
      segments[1] === 'admin'
      && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      && !isSameOrigin(request)
    ) {
      sendJson(response, 403, { error: 'invalid_origin', message: 'Admin requests must come from this origin.' });
      return true;
    }

    if (segments.length === 2 && segments[1] === 'health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return true;
      }
      const configured = isConfigured();
      let connected = false;
      let message = 'MySQL is not configured.';
      if (configured) {
        try {
          connected = await checkConnection();
          message = connected ? 'MySQL connection is healthy.' : 'MySQL connection failed.';
        } catch (error) {
          message = 'MySQL connection failed.';
        }
      }
      sendJson(response, connected ? 200 : 503, {
        database: { configured, connected, message },
        api: { version: 1 },
      });
      return true;
    }

    if (segments.length === 2 && segments[1] === 'public-config') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return true;
      }
      sendJson(response, 200, getPublicConfig());
      return true;
    }

    if (segments[1] === 'orders') {
      // POST /api/orders
      if (segments.length === 2) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
          return true;
        }
        const body = await readJsonBody(request);
        const created = await createOrder(body);
        sendJson(response, 201, { ok: true, order: created });
        return true;
      }

      const orderNumber = decodeURIComponent(segments[2] || '');

      // GET /api/orders/:orderNumber
      if (segments.length === 3) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return true;
        }
        const order = await getOrderByNumber(orderNumber);
        sendJson(response, 200, { ok: true, order });
        return true;
      }

      // PATCH /api/orders/:orderNumber/status
      if (segments.length === 4 && segments[3] === 'status') {
        if (request.method !== 'PATCH' && request.method !== 'POST') {
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'PATCH' });
          return true;
        }
        const body = await readJsonBody(request);
        const updated = await updateOrderStatus(orderNumber, body.status);
        sendJson(response, 200, { ok: true, order: updated });
        return true;
      }
    }

    if (segments[1] === 'admin') {
      // POST /api/admin/auth/login
      if (segments.length === 4 && segments[2] === 'auth' && segments[3] === 'login') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
          return true;
        }
        const body = await readJsonBody(request);
        const session = await authenticateAdmin(body.username, body.password);
        if (session) {
          sendJson(
            response,
            200,
            { ok: true, user: session.user, expiresAt: session.expiresAt },
            { 'Set-Cookie': sessionCookie(session.token, request) },
          );
        } else {
          sendJson(response, 401, { error: 'invalid_credentials', message: 'Invalid admin username or password.' });
        }
        return true;
      }

      // POST /api/admin/auth/logout
      if (segments.length === 4 && segments[2] === 'auth' && segments[3] === 'logout') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
          return true;
        }
        const token = extractAdminToken(request);
        if (token) await destroyAdminSession(token);
        sendJson(
          response,
          200,
          { ok: true },
          { 'Set-Cookie': `${sessionCookie('', request, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` },
        );
        return true;
      }

      // GET /api/admin/auth/verify
      if (segments.length === 4 && segments[2] === 'auth' && segments[3] === 'verify') {
        const session = await resolveAdminSession(request);
        if (!session) {
          sendJson(response, 401, { ok: false, authenticated: false, message: 'Invalid or expired session.' });
          return true;
        }
        sendJson(response, 200, { ok: true, authenticated: true, user: session.username });
        return true;
      }

      // All remaining admin routes require valid admin session
      const currentSession = await resolveAdminSession(request);
      if (!currentSession) {
        sendJson(response, 401, { error: 'unauthorized', message: 'Admin authentication required.' });
        return true;
      }

      if (segments[2] === 'cashbook') {
        if (segments.length === 3 && request.method === 'GET') {
          const result = await cashbook.listCashbookEntries({
            page: url.searchParams.get('page'),
            limit: url.searchParams.get('limit'),
            type: url.searchParams.get('type'),
            period: url.searchParams.get('period'),
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            search: url.searchParams.get('q'),
          });
          sendJson(response, 200, { ok: true, ...result });
          return true;
        }

        if (segments.length === 4 && segments[3] === 'summary' && request.method === 'GET') {
          const summary = await cashbook.getCashbookSummary({
            period: url.searchParams.get('period'),
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
          });
          sendJson(response, 200, { ok: true, summary });
          return true;
        }

        if (segments.length === 4 && segments[3] === 'categories') {
          if (request.method === 'GET') {
            const categories = await cashbook.getCategories({ includeInactive: true });
            sendJson(response, 200, { ok: true, categories });
            return true;
          }
          if (request.method === 'POST') {
            const body = await readJsonBody(request);
            const category = await cashbook.createCategory(body.name);
            sendJson(response, 201, { ok: true, category });
            return true;
          }
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
          return true;
        }

        if (segments.length === 5 && segments[3] === 'categories' && request.method === 'PATCH') {
          const body = await readJsonBody(request);
          const category = await cashbook.setCategoryActive(segments[4], body.isActive);
          sendJson(response, 200, { ok: true, category });
          return true;
        }

        if (segments.length === 4 && segments[3] === 'expenses' && request.method === 'POST') {
          const body = await readJsonBody(request);
          const entry = await cashbook.createExpense(body, currentSession.adminId);
          sendJson(response, 201, { ok: true, entry });
          return true;
        }

        if (segments.length === 5 && segments[3] === 'expenses' && request.method === 'PATCH') {
          const body = await readJsonBody(request);
          const entry = await cashbook.correctExpense(segments[4], body, currentSession.adminId);
          sendJson(response, 200, { ok: true, entry });
          return true;
        }

        if (segments.length === 6 && segments[3] === 'entries' && segments[5] === 'history' && request.method === 'GET') {
          const history = await cashbook.getEntryHistory(segments[4]);
          sendJson(response, 200, { ok: true, history });
          return true;
        }

        sendJson(response, 405, { error: 'method_not_allowed' });
        return true;
      }

      if (segments[2] === 'reports') {
        const filters = {
          period: url.searchParams.get('period'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        };
        if (segments.length === 4 && segments[3] === 'summary' && request.method === 'GET') {
          const summary = await getReportSummary(filters);
          sendJson(response, 200, { ok: true, summary });
          return true;
        }
        if (segments.length === 4 && segments[3] === 'export.xlsx' && request.method === 'GET') {
          const scope = parseScope(url.searchParams.get('scope'));
          const workbook = await createReportWorkbook({ ...filters, scope });
          const range = cashbook.resolveDateRange(filters);
          const filename = `locoxatl-${scope}-${range.from}-to-${range.to}.xlsx`;
          sendBuffer(response, 200, workbook, {
            'Content-Disposition': `attachment; filename="${filename}"`,
          });
          return true;
        }
      }

      // GET /api/admin/metrics
      if (segments.length === 3 && segments[2] === 'metrics') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return true;
        }
        const metrics = await getAdminMetrics();
        sendJson(response, 200, { ok: true, metrics });
        return true;
      }

      // /api/admin/orders ...
      if (segments[2] === 'orders') {
        // GET /api/admin/orders
        if (segments.length === 3) {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
            return true;
          }
          const page = url.searchParams.get('page');
          const limit = url.searchParams.get('limit');
          const status = url.searchParams.get('status');
          const q = url.searchParams.get('q');
          const result = await listOrdersAdmin({ page, limit, status, search: q });
          sendJson(response, 200, { ok: true, ...result });
          return true;
        }

        const orderNumber = decodeURIComponent(segments[3] || '');

        // GET /api/admin/orders/:orderNumber
        if (segments.length === 4) {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
            return true;
          }
          const order = await getOrderDetailAdmin(orderNumber);
          sendJson(response, 200, { ok: true, order });
          return true;
        }

        // PATCH /api/admin/orders/:orderNumber/status
        if (segments.length === 5 && segments[4] === 'status') {
          if (request.method !== 'PATCH' && request.method !== 'POST') {
            sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'PATCH' });
            return true;
          }
          const body = await readJsonBody(request);
          const updated = await updateOrderStatusAdmin(orderNumber, body.status, {
            changedBy: currentSession.username || 'admin',
            adminUserId: currentSession.adminId,
            notes: body.notes || '',
            courier: body.courier !== undefined ? body.courier : null,
            trackingNumber: body.trackingNumber !== undefined ? body.trackingNumber : null,
          });
          sendJson(response, 200, { ok: true, order: updated });
          return true;
        }

        // PATCH /api/admin/orders/:orderNumber/notes
        if (segments.length === 5 && segments[4] === 'notes') {
          if (request.method !== 'PATCH' && request.method !== 'POST') {
            sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'PATCH' });
            return true;
          }
          const body = await readJsonBody(request);
          const updated = await updateOrderAdminNotes(orderNumber, {
            adminNotes: body.adminNotes,
            shippingCourier: body.shippingCourier,
            trackingNumber: body.trackingNumber,
          });
          sendJson(response, 200, { ok: true, order: updated });
          return true;
        }
      }
    }

    sendJson(response, 404, { error: 'not_found', message: 'Unknown API route.' });
    return true;
  } catch (error) {
    mapError(response, error);
    return true;
  }
}

module.exports = { handleApiRequest, sendJson, sendBuffer, readJsonBody, isSameOrigin, sessionCookie };