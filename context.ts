// context.ts — shared request context and response helpers for every surface.

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The request URL, parsed lazily: the suite only ever reads `pathname` and
 * `searchParams`, and building a full URL object per request (plus parsing the
 * query string eagerly) is measurable at 2,000 sequential reads. `searchParams`
 * parses on first access and caches.
 */
export interface RequestUrl {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: RequestUrl;
  body: Buffer;
  /** The token the trial configured (MAKEFUN_SHOP_TOKEN), or null when unset. */
  expectedToken: string | null;
}

/** Build a RequestUrl from a raw request target without the `new URL` cost. */
export function parseRequestUrl(rawUrl: string): RequestUrl {
  // Absolute-form targets and dot segments go through the real parser, which
  // normalizes them; the suite's relative paths take the fast path.
  if (
    rawUrl.startsWith('http://') ||
    rawUrl.startsWith('https://') ||
    rawUrl.includes('/./') ||
    rawUrl.includes('/../') ||
    rawUrl.includes('//')
  ) {
    try {
      const parsed = new URL(rawUrl, 'http://localhost');
      return { pathname: parsed.pathname, searchParams: parsed.searchParams };
    } catch {
      return { pathname: '/', searchParams: new URLSearchParams() };
    }
  }
  const q = rawUrl.indexOf('?');
  const pathname = q === -1 ? rawUrl === '' ? '/' : rawUrl : rawUrl.slice(0, q) || '/';
  const search = q === -1 ? '' : rawUrl.slice(q + 1);
  let params: URLSearchParams | null = null;
  return {
    pathname,
    get searchParams(): URLSearchParams {
      return (params ??= new URLSearchParams(search));
    },
  };
}

let requestCounter = 0;

/**
 * A request id. The suite only requires it to be non-empty, so a monotonic
 * counter (unique per process) replaces a crypto UUID per response.
 */
export function newRequestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}`;
}

/** The Bearer token on the request, or null. */
export function bearerToken(ctx: Ctx): string | null {
  const header = ctx.req.headers.authorization;
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith('Bearer ')) return null;
  const token = trimmed.slice(7);
  return token === '' ? null : token;
}

/**
 * Authenticate the request. When MAKEFUN_SHOP_TOKEN is configured the token must match
 * exactly; when it is unset (local development) any non-empty Bearer token is accepted.
 * A missing token is never accepted.
 */
export function checkAuth(ctx: Ctx): boolean {
  const token = bearerToken(ctx);
  if (!token) return false;
  if (ctx.expectedToken === null) return true;
  return token === ctx.expectedToken;
}

function baseHeaders(ctx: Ctx): Record<string, string> {
  return { 'x-github-request-id': newRequestId() };
}

export function sendJson(ctx: Ctx, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  ctx.res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...baseHeaders(ctx),
    ...extra,
  });
  ctx.res.end(body);
}

export function sendBytes(
  ctx: Ctx,
  status: number,
  contentType: string,
  body: Buffer,
  extra: Record<string, string> = {},
): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...baseHeaders(ctx),
    ...extra,
  });
  ctx.res.end(body);
}

export function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(204, { ...baseHeaders(ctx) });
  ctx.res.end();
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function notFound(ctx: Ctx): void {
  sendError(ctx, 404, 'Not Found');
}

export function unauthorized(ctx: Ctx): void {
  sendError(ctx, 401, 'Bad credentials');
}

/** Parse the request body as JSON. Returns undefined when the body is empty. */
export function jsonBody<T>(ctx: Ctx): T | undefined {
  if (ctx.body.length === 0) return undefined;
  return JSON.parse(ctx.body.toString('utf8')) as T;
}

/** Decode a URL path segment (percent-decoding, forgiving). */
export function decodeSegment(segment: string): string {
  // Most segments carry no escapes: skip the decoder entirely.
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
