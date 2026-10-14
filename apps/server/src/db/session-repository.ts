import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { UserSchema, type User } from '@easymtg/shared';
import type { Database } from './client.js';
import { sessions, users } from './schema.js';

export const SESSION_COOKIE_NAME = 'easymtg_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type CreatedAnonymousSession = { user: User; token: string; expiresAt: Date };

/** Owns opaque-cookie issuance and expiry; callers must never persist or log token. */
export class SessionRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createToken: () => string = () => randomBytes(32).toString('base64url'),
    private readonly createUserId: () => string = randomUUID,
  ) {}

  async createAnonymousUser(displayName: string): Promise<CreatedAnonymousSession> {
    const token = this.createToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Session token source must return a 256-bit base64url token.');
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
    const user = UserSchema.parse({ id: this.createUserId(), displayName, createdAt: createdAt.toISOString() });
    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({ id: user.id, displayName: user.displayName, createdAt });
      await tx.insert(sessions).values({ id: hashToken(token), userId: user.id, createdAt, expiresAt });
    });
    return { user, token, expiresAt };
  }

  /** Resolve a live cookie and slide its 30-day expiry within one transaction. */
  async resolveAndTouch(token: string): Promise<{ user: User; expiresAt: Date } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    return this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(sessions)
        .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, now)))
        .for('update');
      if (!session) return null;
      const [user] = await tx.select().from(users).where(eq(users.id, session.userId));
      if (!user) return null;
      await tx.update(sessions).set({ expiresAt }).where(eq(sessions.id, session.id));
      return {
        user: UserSchema.parse({ id: user.id, displayName: user.displayName, createdAt: user.createdAt.toISOString() }),
        expiresAt,
      };
    });
  }

  /** Delete expired rows in small, lock-skipping batches; deleting a user cascades sessions. */
  async deleteExpiredBatch(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new RangeError('Session cleanup limit must be between 1 and 5000.');
    const result = await this.db.execute(sql`
      WITH expired AS (
        SELECT id FROM sessions WHERE expires_at <= ${this.now()}
        ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM sessions USING expired WHERE sessions.id = expired.id
      RETURNING sessions.id
    `);
    return result.rowCount ?? 0;
  }
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const fields = [
    `${SESSION_COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`, `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) fields.push('Secure');
  return fields.join('; ');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashSessionToken(token: string): string {
  return hashToken(token);
}
