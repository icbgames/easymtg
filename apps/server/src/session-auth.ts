import type { preHandlerHookHandler } from 'fastify';
import { HttpErrorResponseSchema, type User } from '@easymtg/shared';
import { SESSION_COOKIE_NAME, sessionCookie } from './db/session-repository.js';

export type SessionResolver = {
  resolveAndTouch(token: string): Promise<{ user: User; expiresAt: Date } | null>;
};

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: User | null;
  }
}

/** Route preHandler for ordinary user APIs; missing/expired cookies never create a new identity. */
export function requireUserSession(repository: SessionResolver, secure = process.env.NODE_ENV === 'production'): preHandlerHookHandler {
  return async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    const resolved = token ? await repository.resolveAndTouch(token) : null;
    if (!token || !resolved) {
      request.sessionUser = null;
      return reply.code(401).send(HttpErrorResponseSchema.parse({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }));
    }
    request.sessionUser = resolved.user;
    reply.header('set-cookie', sessionCookie(token, resolved.expiresAt, secure));
  };
}

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const values = cookieHeader.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(SESSION_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
