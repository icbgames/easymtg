import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/** Idempotent bounded cleanup for unreferenced immutable Card Definition versions and admin receipts. */
export class CleanupRepository {
  constructor(private readonly db: Database) {}

  async deleteUnreferencedCardVersions(limit = 100): Promise<number> {
    assertBatch(limit);
    const result = await this.db.execute(sql`
      WITH candidates AS (
        SELECT v.card_definition_id, v.version
        FROM card_definition_versions v
        JOIN card_definitions d ON d.id = v.card_definition_id
        WHERE v.version <> d.current_version
          AND NOT EXISTS (
            SELECT 1 FROM game_card_definition_refs r
            WHERE r.card_definition_id = v.card_definition_id AND r.version = v.version
          )
        ORDER BY v.card_definition_id, v.version
        LIMIT ${limit}
        FOR UPDATE OF v SKIP LOCKED
      )
      DELETE FROM card_definition_versions v
      USING candidates c
      WHERE v.card_definition_id = c.card_definition_id AND v.version = c.version
        AND NOT EXISTS (
          SELECT 1 FROM game_card_definition_refs r
          WHERE r.card_definition_id = v.card_definition_id AND r.version = v.version
        )
      RETURNING v.card_definition_id
    `);
    return result.rowCount ?? 0;
  }

  async deleteExpiredAdminResults(before: Date, limit = 100): Promise<number> {
    assertBatch(limit);
    const result = await this.db.execute(sql`
      WITH expired AS (
        SELECT admin_id, request_id FROM admin_request_results
        WHERE created_at <= ${before}
        ORDER BY created_at, admin_id, request_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM admin_request_results r
      USING expired e
      WHERE r.admin_id = e.admin_id AND r.request_id = e.request_id
      RETURNING r.request_id
    `);
    return result.rowCount ?? 0;
  }
}

function assertBatch(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Cleanup batch limit must be between 1 and 1000.');
}
