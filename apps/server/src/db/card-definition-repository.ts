import { and, eq } from 'drizzle-orm';
import {
  CardDefinitionIdSchema, CardDefinitionSearchResponseSchema, CardDefinitionVersionSchema,
  type CardDefinitionSearchResponse, type CardDefinitionVersion, type CardDefinitionVersionWithStatus,
} from '@easymtg/shared';
import type { Database } from './client.js';
import { cardDefinitionVersions, cardDefinitions } from './schema.js';

export type CardSearchSort = 'englishName' | 'japaneseName' | 'cardDefinitionId';
export type CardSearchOrder = 'asc' | 'desc';
export type CardSearchRequest = { query: string; page: number; sort: CardSearchSort[]; order: CardSearchOrder[]; status?: 'ENABLED' | 'DISABLED' | 'ALL' };

/** Card Definition search. General-user callers default to ENABLED; admins may choose either Status or all. */
export class CardDefinitionRepository {
  constructor(private readonly db: Database) {}

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
    const version = CardDefinitionVersionSchema.parse({
      cardDefinitionId: parsedId.data,
      version: row.version.version,
      englishName: row.version.englishName,
      ...(row.version.japaneseName === null ? {} : { japaneseName: row.version.japaneseName }),
      ...(row.version.backName === null ? {} : { backName: row.version.backName }),
      frontImageUrl: row.version.frontImageUrl,
      ...(row.version.backImageUrl === null ? {} : { backImageUrl: row.version.backImageUrl }),
      hasBack: row.version.hasBack,
      ...(row.version.changeDescription === null ? {} : { changeDescription: row.version.changeDescription }),
      rulesData: row.version.rulesData,
      createdAt: row.version.createdAt.toISOString(),
    });
    return { ...version, status: row.status as 'ENABLED' | 'DISABLED' };
  }

  async search(input: CardSearchRequest): Promise<CardDefinitionSearchResponse> {
    const normalizedQuery = input.query.normalize('NFKC').trim();
    if (normalizedQuery.length > 100 || !Number.isInteger(input.page) || input.page < 1 || input.sort.length === 0 ||
        input.sort.length !== input.order.length || new Set(input.sort).size !== input.sort.length) {
      throw new RangeError('Invalid card search request.');
    }
    const rows = await this.db.select({
      cardDefinitionId: cardDefinitions.id,
      version: cardDefinitionVersions.version,
      englishName: cardDefinitionVersions.englishName,
      japaneseName: cardDefinitionVersions.japaneseName,
      backName: cardDefinitionVersions.backName,
      frontImageUrl: cardDefinitionVersions.frontImageUrl,
      backImageUrl: cardDefinitionVersions.backImageUrl,
      hasBack: cardDefinitionVersions.hasBack,
      changeDescription: cardDefinitionVersions.changeDescription,
      rulesData: cardDefinitionVersions.rulesData,
      createdAt: cardDefinitionVersions.createdAt,
      status: cardDefinitions.status,
    }).from(cardDefinitions).innerJoin(cardDefinitionVersions, and(
      eq(cardDefinitionVersions.cardDefinitionId, cardDefinitions.id),
      eq(cardDefinitionVersions.version, cardDefinitions.currentVersion),
    )).where(input.status === 'ALL' ? undefined : eq(cardDefinitions.status, input.status ?? 'ENABLED'));

    const terms = normalizedQuery.split(/[\s\u3000]+/u).filter(Boolean).map((term) => term.toLocaleLowerCase());
    const statusById = new Map(rows.map((row) => [row.cardDefinitionId, row.status as 'ENABLED' | 'DISABLED']));
    const items: CardDefinitionVersionWithStatus[] = rows.map((row) => CardDefinitionVersionSchema.parse({
      cardDefinitionId: row.cardDefinitionId,
      version: row.version,
      englishName: row.englishName,
      ...(row.japaneseName === null ? {} : { japaneseName: row.japaneseName }),
      ...(row.backName === null ? {} : { backName: row.backName }),
      frontImageUrl: row.frontImageUrl,
      ...(row.backImageUrl === null ? {} : { backImageUrl: row.backImageUrl }),
      hasBack: row.hasBack,
      ...(row.changeDescription === null ? {} : { changeDescription: row.changeDescription }),
      rulesData: row.rulesData,
      createdAt: row.createdAt.toISOString(),
    })).map((version) => ({ ...version, status: statusById.get(version.cardDefinitionId)! }))
      .filter((item) => input.status === 'ALL' || item.status === (input.status ?? 'ENABLED'))
      .filter((item) => terms.every((term) =>
      [item.cardDefinitionId, item.englishName, item.japaneseName ?? ''].some((field) =>
        field.normalize('NFKC').toLocaleLowerCase().includes(term),
      ),
    ));

    items.sort((a, b) => {
      for (let index = 0; index < input.sort.length; index += 1) {
        const field = input.sort[index]!;
        const left = field === 'englishName' ? a.englishName : field === 'japaneseName' ? a.japaneseName ?? '' : a.cardDefinitionId;
        const right = field === 'englishName' ? b.englishName : field === 'japaneseName' ? b.japaneseName ?? '' : b.cardDefinitionId;
        const compared = left.localeCompare(right, 'en');
        if (compared !== 0) return input.order[index] === 'desc' ? -compared : compared;
      }
      return input.sort.includes('cardDefinitionId') ? 0 : a.cardDefinitionId.localeCompare(b.cardDefinitionId, 'en');
    });

    const pageSize = 50 as const;
    return CardDefinitionSearchResponseSchema.parse({
      items: items.slice((input.page - 1) * pageSize, input.page * pageSize),
      page: input.page,
      pageSize,
      totalCount: items.length,
      totalPages: Math.ceil(items.length / pageSize),
    });
  }

  async getVersion(cardDefinitionId: string, version: number): Promise<CardDefinitionVersion | null> {
    const id = CardDefinitionIdSchema.safeParse(cardDefinitionId);
    if (!id.success || !Number.isSafeInteger(version) || version < 1) return null;
    const [row] = await this.db.select().from(cardDefinitionVersions).where(and(
      eq(cardDefinitionVersions.cardDefinitionId, id.data), eq(cardDefinitionVersions.version, version),
    ));
    return row ? CardDefinitionVersionSchema.parse({
      cardDefinitionId: row.cardDefinitionId,
      version: row.version,
      englishName: row.englishName,
      ...(row.japaneseName === null ? {} : { japaneseName: row.japaneseName }),
      ...(row.backName === null ? {} : { backName: row.backName }),
      hasBack: row.hasBack,
      frontImageUrl: row.frontImageUrl,
      ...(row.backImageUrl === null ? {} : { backImageUrl: row.backImageUrl }),
      createdAt: row.createdAt.toISOString(),
      ...(row.changeDescription === null ? {} : { changeDescription: row.changeDescription }),
      rulesData: row.rulesData,
    }) : null;
  }
}
