import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireUserSession, readSessionCookie } from './session-auth.js';

const token = 'T'.repeat(43);
const user = { id: 'f2a3aa30-9191-4c48-aa76-84df905f3254', displayName: 'Player', createdAt: '2026-10-10T00:00:00.000Z' };

describe('session authentication', () => {
  it('accepts one correctly shaped opaque session cookie only', () => {
    expect(readSessionCookie(`theme=dark; easymtg_session=${token}`)).toBe(token);
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie(`easymtg_session=short`)).toBeNull();
    expect(readSessionCookie(`easymtg_session=${token}; easymtg_session=${token}`)).toBeNull();
  });

  it('rejects missing identity and refreshes an authenticated session cookie', async () => {
    const app = Fastify();
    const repository = { resolveAndTouch: async (value: string) => value === token ? { user, expiresAt: new Date('2026-11-09T00:00:00.000Z') } : null };
    app.get('/private', { preHandler: requireUserSession(repository, false) }, async (request) => ({ userId: request.sessionUser?.id }));
    try {
      const unauthorized = await app.inject({ method: 'GET', url: '/private' });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });

      const accepted = await app.inject({ method: 'GET', url: '/private', headers: { cookie: `easymtg_session=${token}` } });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ userId: user.id });
      expect(accepted.headers['set-cookie']).toContain('HttpOnly');
      expect(accepted.headers['set-cookie']).not.toContain('Secure');
    } finally {
      await app.close();
    }
  });
});
