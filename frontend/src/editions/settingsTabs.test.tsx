import { describe, it, expect } from 'vitest';
import { edition } from './selfhost';
import { story } from '../test-story';

describe('selfhost edition', () => {
  it('nie dodaje zakładek ustawień ani akcji w banerze blokady', (ctx) => {
    story(ctx, 'Wersja self-hosted nie ma zakładki Subskrypcja ani przycisku w banerze.');
    expect(edition.settingsTabs ?? []).toHaveLength(0);
    expect(edition.LockedBannerAction ?? null).toBeNull();
  });
});
