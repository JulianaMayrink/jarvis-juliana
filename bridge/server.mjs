/**
 * Ponte HTTP local entre a interface e a conversa com o Claude.
 *
 * - Escuta somente em 127.0.0.1.
 * - Aceita apenas os cabeçalhos Host e Origin esperados (contra DNS rebinding
 *   e páginas de outros sites).
 * - Rotas: GET /health, GET /events (SSE), POST /ask (JSON `{ text }`).
 */
import { createServer } from 'node:http';
import { createConversation } from './session.mjs';

/** Origens de navegador que podem falar com a ponte (interface em dev e preview). */
export const DEFAULT_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
];

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 4000;
const PING_MS = 15_000;

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJson(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Use Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo grande demais.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

/**
 * Sobe a ponte.
 *
 * @param {object} options
 * @param {(input: any) => AsyncIterable<any> & { close?: () => void }} options.query
 * @param {string} [options.cwd]
 * @param {number} [options.port] porta; 0 escolhe uma livre
 * @param {string[]} [options.allowedOrigins]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startBridge({
  query,
  cwd = process.cwd(),
  port = 8787,
  allowedOrigins = DEFAULT_ORIGINS,
}) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  /** @type {ReturnType<typeof createConversation> | null} */
  let conversation = null;

  /** @param {unknown} message */
  const broadcast = (message) => {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of clients) res.write(line);
  };

  const ensureConversation = () => {
    if (!conversation) {
      conversation = createConversation({
        query,
        cwd,
        onMessage: broadcast,
        onEnd: () => {
          conversation = null;
        },
      });
    }
    return conversation;
  };

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;

      const host = req.headers.host;
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
        throw new HttpError(403, 'Host não permitido.');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.includes(origin)) {
        throw new HttpError(403, 'Origem não permitida.');
      }

      const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': conectado\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/ask') {
        const body = /** @type {{ text?: unknown } | null} */ (await readJson(req));
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (!text) throw new HttpError(400, 'Campo "text" vazio.');
        if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, 'Texto grande demais.');
        ensureConversation().send(text);
        sendJson(res, 202, { ok: true });
        return;
      }

      throw new HttpError(404, 'Não encontrado.');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Erro interno.';
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });

  const address = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const res of clients) res.end();
        clients.clear();
        conversation?.close();
        conversation = null;
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
