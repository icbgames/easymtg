import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  CardDefinitionIdSchema, CardDefinitionVersionSchema, CardDefinitionVersionWithStatusSchema,
  type CardDefinitionVersion, type CardDefinitionVersionWithStatus,
} from '@easymtg/shared';
import type { Database } from './client.js';
import { adminRequestResults, cardDefinitionVersions, cardDefinitions } from './schema.js';
import { CardDefinitionRepository } from './card-definition-repository.js';

export type AdminTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type MutationResult = { status: number; body: Record<string, unknown> };
export type AdminVersionInput = Omit<CardDefinitionVersion, 'cardDefinitionId' | 'version' | 'createdAt'>;

export class AdminCardDefinitionRepository {
  private readonly searchRepository: CardDefinitionRepository;

  constructor(private readonly db: Database) {
    this.searchRepository = new CardDefinitionRepository(db);
  }

  search(input: import('./card-definition-repository.js').CardSearchRequest) {
    return this.searchRepository.search(input);
  }

  async getLatest(id: string): Promise<CardDefinitionVersionWithStatus | null> {
    const parsedId = CardDefinitionIdSchema.safeParse(id);
    if (!parsedId.success) return null;
    const [row] = await this.db.select({
      version: cardDefinitionVersions, status: cardDefinitions.status,
    }).from(cardDefinitions).innerJoin(cardDefinitionVersions, and(
      eq(cardDefinitionVersions.cardDefinitionId, cardDefinitions.id),
      eq(cardDefinitionVersions.version, cardDefinitions.currentVersion),
    )).where(eq(cardDefinitions.id, parsedId.data));
    if (!row) return null;
    return CardDefinitionVersionWithStatusSchema.parse({
      ...toVersionPayload(row.version), status: row.status,
    });
  }

  async getVersion(id: string, version: number): Promise<CardDefinitionVersion | null> {
    const parsedId = CardDefinitionIdSchema.safeParse(id);
    if (!parsedId.success || !Number.isSafeInteger(version) || version < 1) return null;
    const [row] = await this.db.select().from(cardDefinitionVersions).where(and(
      eq(cardDefinitionVersions.cardDefinitionId, parsedId.data), eq(cardDefinitionVersions.version, version),
    ));
    return row ? CardDefinitionVersionSchema.parse(toVersionPayload(row)) : null;
  }

  async mutate(
    adminId: string,
    requestId: string,
    fingerprint: string,
    action: (tx: AdminTransaction) => Promise<MutationResult>,
  ): Promise<MutationResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${adminId}:${requestId}`}, 2))`);
      const [prior] = await tx.select().from(adminRequestResults).where(and(
        eq(adminRequestResults.adminId, adminId), eq(adminRequestResults.requestId, requestId),
      ));
      if (prior) {
        if (prior.fingerprint !== fingerprint) return { status: 409, body: errorBody('REQUEST_ID_CONFLICT', 'This requestId was already used for a different request.') };
        return { status: prior.httpStatus, body: prior.responseBody };
      }

      const result = await action(tx);
      await tx.insert(adminRequestResults).values({
        adminId, requestId, fingerprint, httpStatus: result.status, responseBody: result.body,
      });
      return result;
    });
  }

  async create(
    tx: AdminTransaction,
    id: string,
    status: 'ENABLED' | 'DISABLED',
    version: AdminVersionInput,
  ): Promise<MutationResult> {
    const parsedId = CardDefinitionIdSchema.safeParse(id.toUpperCase());
    if (!parsedId.success) return { status: 400, body: errorBody('INVALID_REQUEST', 'Invalid Card Definition ID.') };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${parsedId.data}, 3))`);
    const [existing] = await tx.select({ id: cardDefinitions.id }).from(cardDefinitions).where(eq(cardDefinitions.id, parsedId.data));
    if (existing) return { status: 409, body: errorBody('CARD_DEFINITION_ID_ALREADY_EXISTS', 'Card Definition ID already exists.') };
    const createdAt = new Date();
    const fullVersion = CardDefinitionVersionSchema.parse({
      ...version, cardDefinitionId: parsedId.data, version: 1, createdAt: createdAt.toISOString(),
    });
    await tx.insert(cardDefinitions).values({ id: parsedId.data, status, currentVersion: 1 });
    await tx.insert(cardDefinitionVersions).values(versionRow(fullVersion, createdAt));
    return { status: 201, body: { data: { cardDefinitionId: parsedId.data, status, version: fullVersion } } };
  }

  async appendVersion(
    tx: AdminTransaction,
    id: string,
    expectedVersion: number,
    version: AdminVersionInput,
    status?: 'ENABLED' | 'DISABLED',
  ): Promise<MutationResult> {
    const parsedId = CardDefinitionIdSchema.safeParse(id);
    if (!parsedId.success) return { status: 400, body: errorBody('INVALID_REQUEST', 'Invalid Card Definition ID.') };
    const [definition] = await tx.select().from(cardDefinitions).where(eq(cardDefinitions.id, parsedId.data)).for('update');
    if (!definition) return { status: 404, body: errorBody('CARD_DEFINITION_NOT_FOUND', 'Card Definition not found.') };
    if (definition.currentVersion !== expectedVersion) {
      return { status: 409, body: errorBody('CARD_DEFINITION_VERSION_CONFLICT', 'Card Definition Version conflict.') };
    }
    const createdAt = new Date();
    const fullVersion = CardDefinitionVersionSchema.parse({
      ...version, cardDefinitionId: parsedId.data, version: expectedVersion + 1, createdAt: createdAt.toISOString(),
    });
    await tx.insert(cardDefinitionVersions).values(versionRow(fullVersion, createdAt));
    const nextStatus = status ?? definition.status as 'ENABLED' | 'DISABLED';
    await tx.update(cardDefinitions).set({ currentVersion: fullVersion.version, status: nextStatus })
      .where(eq(cardDefinitions.id, parsedId.data));
    return { status: 200, body: { data: { cardDefinitionId: parsedId.data, status: nextStatus, version: fullVersion } } };
  }

  async changeStatus(
    tx: AdminTransaction,
    id: string,
    status: 'ENABLED' | 'DISABLED',
  ): Promise<MutationResult> {
    const parsedId = CardDefinitionIdSchema.safeParse(id);
    if (!parsedId.success) return { status: 400, body: errorBody('INVALID_REQUEST', 'Invalid Card Definition ID.') };
    const [definition] = await tx.select().from(cardDefinitions).where(eq(cardDefinitions.id, parsedId.data)).for('update');
    if (!definition) return { status: 404, body: errorBody('CARD_DEFINITION_NOT_FOUND', 'Card Definition not found.') };
    await tx.update(cardDefinitions).set({ status }).where(eq(cardDefinitions.id, parsedId.data));
    return { status: 200, body: { data: { cardDefinitionId: parsedId.data, status, currentVersion: definition.currentVersion } } };
  }
}

export function adminRequestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function versionRow(version: CardDefinitionVersion, createdAt: Date) {
  return {
    cardDefinitionId: version.cardDefinitionId, version: version.version,
    englishName: version.englishName, japaneseName: version.japaneseName ?? null,
    backName: version.backName ?? null, hasBack: version.hasBack,
    frontImageUrl: version.frontImageUrl, backImageUrl: version.backImageUrl ?? null,
    changeDescription: version.changeDescription ?? null, rulesData: version.rulesData, createdAt,
  };
}

function toVersionPayload(row: typeof cardDefinitionVersions.$inferSelect) {
  return {
    cardDefinitionId: row.cardDefinitionId,
    version: row.version,
    englishName: row.englishName,
    ...(row.japaneseName === null ? {} : { japaneseName: row.japaneseName }),
    ...(row.backName === null ? {} : { backName: row.backName }),
    hasBack: row.hasBack,
    frontImageUrl: row.frontImageUrl,
    ...(row.backImageUrl === null ? {} : { backImageUrl: row.backImageUrl }),
    ...(row.changeDescription === null ? {} : { changeDescription: row.changeDescription }),
    rulesData: row.rulesData,
    createdAt: row.createdAt.toISOString(),
  };
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
