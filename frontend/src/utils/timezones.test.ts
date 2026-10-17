import { describe, it, expect } from 'vitest';
import { DEFAULT_TIMEZONE, selectableTimezones } from './timezones';
import { story } from '../test-story';

describe('selectableTimezones', () => {
  it('adds UTC when the runtime list omits it', (ctx) => {
    story(ctx, 'Chromium nie zwraca "UTC" na liście stref, a nowe konta mają UTC jako domyślną — bez dopisania go konto w UTC pokazywałoby obcą strefę i nie dałoby się do UTC wrócić.');
    const list = selectableTimezones(['Europe/Warsaw', 'America/Denver']);
    expect(list[0]).toBe('UTC');
    expect(list).toContain('Europe/Warsaw');
    expect(list).toHaveLength(3);
  });

  it('does not duplicate UTC when the runtime already lists it', (ctx) => {
    story(ctx, 'Przeglądarki, które UTC na liście mają (np. WebKit), nie dostają drugiej, zdublowanej pozycji.');
    const list = selectableTimezones(['Africa/Abidjan', 'UTC']);
    expect(list.filter(z => z === 'UTC')).toHaveLength(1);
  });

  it('defaults to UTC', () => {
    expect(DEFAULT_TIMEZONE).toBe('UTC');
  });
});
