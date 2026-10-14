import { describe, expect, it } from 'vitest';
import { GameCommandPayloadSchemas } from './commands.js';

describe('game command payload schemas', () => {
  it('defines payload validation for every game and ViewState command', () => {
    const validPayloads: Record<keyof typeof GameCommandPayloadSchemas, unknown> = {
      MoveCard: { cardId: 'card-1', destinationZoneId: 'zone-1' },
      ReorderCard: { cardId: 'card-1', insertIndex: 0 },
      TapCard: { cardId: 'card-1' },
      UntapCard: { cardId: 'card-1' },
      TurnFaceDown: { cardId: 'card-1' },
      TurnFaceUp: { cardId: 'card-1' },
      AddCounter: { cardId: 'card-1', counterType: 'OTHER', amount: 1 },
      RemoveCounter: { cardId: 'card-1', counterType: 'PLUS_ONE_PLUS_ONE', amount: 1 },
      ChangeController: { cardId: 'card-1', controllerPlayerId: 'player-2' },
      ChangeVisibility: { cardId: 'card-1', visibility: 'PUBLIC' },
      MoveCardPosition: { cardId: 'card-1', position: { x: -1, y: 2 } },
      ChangeLife: { amount: -3 },
      ShuffleZone: { zoneId: 'zone-1' },
      ChangeTurnPosition: { phase: 'ENDING', step: 'CLEANUP' },
      EndTurn: undefined,
      Concede: undefined,
      StartView: { sourceZoneId: 'zone-1', viewType: 'LIBRARY_TOP', count: 3 },
      SelectViewCard: { viewId: 'view-1', cardId: 'card-1', selected: true },
      ReorderViewCards: { viewId: 'view-1', cardIds: ['card-1'] },
      ConfirmView: { viewId: 'view-1', moves: [] },
      CancelView: { viewId: 'view-1' },
    };

    for (const [command, schema] of Object.entries(GameCommandPayloadSchemas)) {
      expect(schema.safeParse(validPayloads[command as keyof typeof GameCommandPayloadSchemas]).success, command).toBe(true);
    }
  });

  it('rejects invalid command shapes and enforces state-dependent MoveCard options that are knowable from input', () => {
    expect(GameCommandPayloadSchemas.MoveCard.safeParse({ cardId: 'card-1', destinationZoneId: 'zone-1', position: { x: 0, y: 0 }, insertIndex: 0 }).success).toBe(false);
    expect(GameCommandPayloadSchemas.ReorderCard.safeParse({ cardId: 'card-1', insertIndex: -1 }).success).toBe(false);
    expect(GameCommandPayloadSchemas.AddCounter.safeParse({ cardId: 'card-1', counterType: 'OTHER', amount: 0 }).success).toBe(false);
    expect(GameCommandPayloadSchemas.EndTurn.safeParse({}).success).toBe(false);
    expect(GameCommandPayloadSchemas.StartView.safeParse({ sourceZoneId: 'zone-1', viewType: 'LIBRARY_TOP' }).success).toBe(false);
    expect(GameCommandPayloadSchemas.StartView.safeParse({ sourceZoneId: 'zone-1', viewType: 'ZONE_VIEW', count: 2 }).success).toBe(false);
    expect(GameCommandPayloadSchemas.ConfirmView.safeParse({
      viewId: 'view-1', moves: [{ cardId: 'card-1', destinationZoneId: 'zone-1', position: { x: 0, y: 0 }, insertIndex: 0 }],
    }).success).toBe(false);
  });
});
