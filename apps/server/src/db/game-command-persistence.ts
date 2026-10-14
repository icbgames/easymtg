import { createHash } from 'node:crypto';
import { CommandEnvelopeSchema } from '@easymtg/shared';
import { createGameEventView } from '@easymtg/game';
import type { CommandPersistenceAdapter, PersistedCommandInput } from '@easymtg/game';
import { GameRepository } from './game-repository.js';

/** Bridges the rule processor to the PostgreSQL transaction boundary. */
export class PostgresGameCommandPersistence implements CommandPersistenceAdapter {
  constructor(private readonly repository: GameRepository) {}

  async persist(input: PersistedCommandInput) {
    const envelope = CommandEnvelopeSchema.safeParse(input.command);
    const fingerprintPayload = envelope.success
      ? { type: envelope.data.type, payload: envelope.data.payload }
      : { malformedEnvelope: input.command };
    const fingerprint = createHash('sha256').update(canonicalJson({
      gameId: input.gameId,
      actorPlayerId: input.actorPlayerId,
      command: fingerprintPayload,
    })).digest('hex');
    const eventViews = input.event && input.state
      ? input.state.players.map(({ playerId }) => ({
          recipientPlayerId: playerId,
          payload: createGameEventView(input.event!, input.state!, playerId),
        }))
      : undefined;
    return this.repository.persistCommand({
      gameId: input.gameId,
      actorPlayerId: input.actorPlayerId,
      commandId: input.commandId,
      fingerprint,
      expectedSequence: input.expectedSequence,
      result: input.result,
      ...(input.state ? { state: input.state } : {}),
      ...(input.event ? { event: input.event } : {}),
      ...(eventViews ? { eventViews } : {}),
      ...(input.viewStateChange ? { viewStateChange: input.viewStateChange } : {}),
    });
  }
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
