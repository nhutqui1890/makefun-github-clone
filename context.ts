// context.ts — shared request context and response helpers for every surface.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  body: Buffer;
  /** The token the trial configured (MAKEFUN_SHOP_TOKEN), or null when unset. */
  expectedToken: string | null;
}

export function newRequestId(): string {
  return randomUUID();
}

/** The Bearer token on the request, or null. */
export function bearerToken(ctx: Ctx): string | null {
  const header = ctx.req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1]! : null;
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
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
