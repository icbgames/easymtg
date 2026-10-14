import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { AdminVersionInput } from './admin-card-definition-repository.js';
import { AdminCardDefinitionRepository } from './admin-card-definition-repository.js';
import { createDatabase } from './client.js';
import { adminRequestResults, cardDefinitionVersions, cardDefinitions } from './schema.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('AdminCardDefinitionRepository PostgreSQL integration', () => {
  afterAll(async () => { await database?.pool.end(); });

  it('commits Card Definition changes with idempotency results atomically', async () => {
    const repository = new AdminCardDefinitionRepository(database!.db);
    const cardId = newCardId();
    const adminId = `test-admin-${randomUUID()}`;
    const createRequestId = randomUUID();
    const statusRequestId = randomUUID();
    const versionRequestId = randomUUID();
    const firstVersion: AdminVersionInput = {
      englishName: 'Integration Test Card', frontImageUrl: `https://cards.example.test/${cardId}.jpg`,
      hasBack: false, rulesData: {},
    };
    const secondVersion: AdminVersionInput = {
      ...firstVersion, englishName: 'Updated Integration Test Card', changeDescription: 'Integration test update',
    };
    try {
      const created = await repository.mutate(adminId, createRequestId, 'create-fingerprint',
        (tx) => repository.create(tx, cardId.toLowerCase(), 'DISABLED', firstVersion));
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ data: { cardDefinitionId: cardId, status: 'DISABLED', version: { version: 1 } } });
      expect(await repository.mutate(adminId, createRequestId, 'create-fingerprint',
        (tx) => repository.create(tx, cardId, 'DISABLED', firstVersion))).toEqual(created);
      expect((await repository.mutate(adminId, createRequestId, 'different-fingerprint',
        (tx) => repository.create(tx, cardId, 'DISABLED', firstVersion))).body).toMatchObject({
        error: { code: 'REQUEST_ID_CONFLICT' },
      });

      const statusResult = await repository.mutate(adminId, statusRequestId, 'status-fingerprint',
        (tx) => repository.changeStatus(tx, cardId, 'ENABLED'));
      expect(statusResult.body).toMatchObject({ data: { status: 'ENABLED', currentVersion: 1 } });

      const versionResult = await repository.mutate(adminId, versionRequestId, 'version-fingerprint',
        (tx) => repository.appendVersion(tx, cardId, 1, secondVersion, 'DISABLED'));
      expect(versionResult.body).toMatchObject({ data: { status: 'DISABLED', version: { version: 2 } } });
      expect(await repository.mutate(adminId, versionRequestId, 'version-fingerprint',
        (tx) => repository.appendVersion(tx, cardId, 1, secondVersion, 'DISABLED'))).toEqual(versionResult);
      expect(await repository.getLatest(cardId)).toMatchObject({ status: 'DISABLED', version: 2, englishName: secondVersion.englishName });
      expect(await repository.getVersion(cardId, 1)).toMatchObject({ version: 1, englishName: firstVersion.englishName });
      const disabledSearch = await repository.search({
        query: 'integration test', page: 1, sort: ['englishName'], order: ['asc'], status: 'ALL',
      });
      expect(disabledSearch.items).toContainEqual(expect.objectContaining({ cardDefinitionId: cardId, status: 'DISABLED' }));
    } finally {
      await database!.db.transaction(async (tx) => {
        await tx.delete(adminRequestResults).where(and(
          eq(adminRequestResults.adminId, adminId), inArray(adminRequestResults.requestId, [createRequestId, statusRequestId, versionRequestId]),
        ));
        await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardId));
        await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardId));
      });
    }
  });
});

function newCardId(): string {
  const letters = [...randomBytes(3)].map((value) => String.fromCharCode(65 + value % 26)).join('');
  const digits = String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, '0');
  return `${letters}${digits}`;
}
