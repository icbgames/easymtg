import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { hashSessionToken, SESSION_TTL_MS, SessionRepository, sessionCookie } from './session-repository.js';
import { sessions, users } from './schema.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('SessionRepository PostgreSQL integration', () => {
  afterAll(async () => { await database?.pool.end(); });

  it('stores only a token hash, slides expiry, and removes expired sessions', async () => {
    let now = new Date('2026-10-10T00:00:00.000Z');
    const token = 'A'.repeat(43);
    const db = database!.db;
    const repository = new SessionRepository(db, () => new Date(now), () => token);
    const created = await repository.createAnonymousUser('Integration player');
    try {
      expect(created.token).toBe(token);
      expect(created.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
      const [stored] = await db.select().from(sessions).where(eq(sessions.userId, created.user.id));
      expect(stored?.id).toBe(hashSessionToken(token));
      expect(stored?.id).not.toBe(token);

      now = new Date(now.getTime() + 60_000);
      const resolved = await repository.resolveAndTouch(token);
      expect(resolved?.user.id).toBe(created.user.id);
      expect(resolved?.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);

      now = new Date(resolved!.expiresAt.getTime() + 1);
      expect(await repository.resolveAndTouch(token)).toBeNull();
      expect(await repository.deleteExpiredBatch()).toBe(1);
      expect(await repository.deleteExpiredBatch()).toBe(0);
    } finally {
      await db.delete(users).where(eq(users.id, created.user.id));
    }
  });
});

describe('sessionCookie', () => {
  it('sets the approved attributes and only adds Secure when requested', () => {
    const cookie = sessionCookie('opaque-token', new Date('2026-11-09T00:00:00.000Z'), false);
    expect(cookie).toContain('easymtg_session=opaque-token');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    expect(sessionCookie('opaque-token', new Date(), true)).toContain('Secure');
  });
});
