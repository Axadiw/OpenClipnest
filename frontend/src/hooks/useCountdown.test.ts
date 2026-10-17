import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCountdown } from './useCountdown';
import { story } from '../test-story';

describe('useCountdown', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts inactive at zero', (ctx) => {
    story(ctx, 'Zanim wpadnie pierwszy 429, żaden licznik nie tyka i nic się nie renderuje — hook jest cichy w spoczynku.');
    const { result } = renderHook(() => useCountdown());
    expect(result.current.remaining).toBe(0);
    expect(result.current.active).toBe(false);
  });

  it('counts down once per second to zero, then goes inactive', (ctx) => {
    story(ctx, 'Użytkownik widzi tykające "Spróbuj za 0:03 → 0:02 → 0:01 → 0:00", a po wyzerowaniu powiadomienie znika (active=false).');
    const { result } = renderHook(() => useCountdown());
    act(() => { result.current.start(3); });
    expect(result.current.remaining).toBe(3);
    expect(result.current.active).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.remaining).toBe(2);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.remaining).toBe(0);
    expect(result.current.active).toBe(false);
  });

  it('coalesces concurrent starts: larger extends, smaller never shortens', (ctx) => {
    story(ctx, 'Jeden CMD+R odpala kilka równoległych 429 (getVersion+getEvents+getCameras). Pokazujemy JEDEN licznik — większy Retry-After wydłuża, mniejszy nie skraca już trwającego odliczania.');
    const { result } = renderHook(() => useCountdown());
    act(() => { result.current.start(5); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.remaining).toBe(4);
    act(() => { result.current.start(2); }); // smaller → ignored
    expect(result.current.remaining).toBe(4);
    act(() => { result.current.start(10); }); // larger → extend
    expect(result.current.remaining).toBe(10);
  });

  it('ignores non-positive and non-finite starts', (ctx) => {
    story(ctx, 'Brak/zepsuty nagłówek Retry-After (0, ujemny, NaN) nie może uruchomić fałszywego licznika "0:00" — hook zostaje nieaktywny.');
    const { result } = renderHook(() => useCountdown());
    act(() => { result.current.start(0); });
    act(() => { result.current.start(-5); });
    act(() => { result.current.start(NaN); });
    expect(result.current.active).toBe(false);
    expect(result.current.remaining).toBe(0);
  });
});
