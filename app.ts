// app.ts — the forge's HTTP server: reads each request's body, authenticates it, and
// dispatches to the git smart-HTTP, REST v3, GraphQL v4 and MCP handlers.
//
// Surfaces:
//   GET  /healthz                          health probe (no auth)
//   GET  /api/v3/, /api/v3/meta, /api/v3/user, /api/v3/user/repos, /api/v3/repos/...  REST v3
//   POST /api/graphql                      GraphQL v4
//   POST /mcp                              MCP (JSON-RPC 2.0)
//   /<owner>/<repo>.git/info/refs          git smart-HTTP advertisements (v0 + v2)
//   /<owner>/<repo>.git/git-upload-pack    clone / fetch
//   /<owner>/<repo>.git/git-receive-pack   push

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { checkAuth, sendJson, sendError, notFound, parseRequestUrl, type Ctx } from './context.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB — packs from real git clients can be large
const EMPTY_BODY = Buffer.alloc(0);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = parseRequestUrl(req.url ?? '/');
      const ctx: Ctx = { req, res, method, url, body: EMPTY_BODY, expectedToken };
      try {
        // The health probe answers without auth and without reading a body.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        // GET and HEAD never carry a body in this API: answer without waiting
        // for the request stream's 'end' event (one event-loop turn per read).
        // resume() drains any stray body bytes so the keep-alive socket stays clean.
        if (method !== 'GET' && method !== 'HEAD') {
          ctx.body = await readBody(req);
        } else {
          req.resume();
        }

        // Every other surface requires the trial token.
        if (!checkAuth(ctx)) {
          sendError(ctx, 401, 'Bad credentials');
          return;
        }

        const path = url.pathname;
        if (path === '/api/graphql') {
          handleGraphQL(ctx);
          return;
        }
        if (path === '/mcp') {
          handleMcp(ctx);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handleRest(ctx);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch) {
          handleGit(ctx, decodeURIComponent(gitMatch[1]!), decodeURIComponent(gitMatch[2]!), gitMatch[3]!);
          return;
        }
        notFound(ctx);
      } catch (err) {
        // A handler failure must never crash the server or hang the connection.
        if (!res.writableEnded) {
          try {
            sendError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            res.destroy();
          }
        }
      }
    })();
  });
}
