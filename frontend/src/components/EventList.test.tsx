import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventList } from './EventList';
import type { CameraEvent } from '../types';
import { story } from '../test-story';

vi.mock('../api', () => ({
  api: {
    fetchThumbnailBlob: (id: string) => Promise.resolve(`blob:thumbnail-${id}`),
    getEvent: (id: string) => Promise.resolve({ event: { id, thumbnail: null } }),
  },
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => key,
    language: 'en',
  }),
}));

// The first-time empty state asks the server for its FTP details; not what
// these tests are about, so it gets none.
vi.mock('../hooks/useServerConfig', () => ({
  useServerConfig: () => null,
}));

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const baseEvent: CameraEvent = {
  id: 'e1',
  camera: 'Front',
  timestamp: '2026-04-01T10:00:00.000Z',
  date: '2026/04/01',
  views: [{ id: '00', videoRelPath: '2026/04/01/Front_00.mp4', label: 'profile.view.wide', iconKind: 'wide' }],
  thumbnail: '2026/04/01/Front_00.jpg',
};

const baseProps = {
  total: 1,
  loading: false,
  loadingMore: false,
  hasMore: false,
  onLoadMore: vi.fn(),
  onPlay: vi.fn(),
  thumbSize: 'M' as const,
};

describe('EventList', () => {
  it('keeps day-group DOM node stable across auto-refresh re-renders even when the relative-time label shifts', (ctx) => {
    story(
      ctx,
      'Co 60s tło woła loadEvents() i siatka klipów dostaje nową referencję events[]. Dla day-groupów spoza "dzisiaj/wczoraj" nagłówek dnia zawiera relatywny czas (np. "5 days ago") liczony przez formatDistanceToNow, który po minucie może zwrócić inny string. Wcześniej React key day-groupa = pełny label → zmiana stringa unmountowała cały <div> z grupą wraz z EventCardami, kasowała blob URL thumbnaila w AuthImage i powodowała widoczny błysk szarego placeholdera. Test pilnuje, że DOM-node day-groupa przeżywa rerender z przesuniętym czasem.',
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));

    const ev: CameraEvent = { ...baseEvent };
    const { container, rerender } = render(<EventList events={[ev]} {...baseProps} />);

    const dayGroupBefore = container.querySelector('.event-list > div');
    expect(dayGroupBefore).toBeTruthy();
    const labelBefore = dayGroupBefore?.querySelector('.day-header')?.textContent ?? '';
    expect(labelBefore).toMatch(/ago/);

    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
    rerender(<EventList events={[{ ...ev }]} {...baseProps} />);

    const dayGroupAfter = container.querySelector('.event-list > div');
    const labelAfter = dayGroupAfter?.querySelector('.day-header')?.textContent ?? '';

    expect(labelAfter).not.toBe(labelBefore);
    expect(dayGroupAfter).toBe(dayGroupBefore);
  });

  it('shows the first-time empty state when there are no events and no active filter', (ctx) => {
    story(ctx, 'Pusta siatka bez aktywnych filtrów to świeże konto — pokazujemy onboardingowy komunikat "brak nagrań", a nie sugerujemy czyszczenia nieistniejących filtrów.');
    render(<EventList events={[]} {...baseProps} hasActiveFilter={false} />);
    expect(screen.getByText('events.emptyFirstTime.title')).toBeInTheDocument();
    expect(screen.queryByText('events.emptyFiltered.title')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'events.clearFilters' })).not.toBeInTheDocument();
  });

  it('shows the filtered empty state + working Clear filters when filters hide every recording', (ctx) => {
    story(ctx, 'Gdy aktywne filtry odsiały wszystkie nagrania, siatka pokazuje "nic nie pasuje do filtrów" + przycisk czyszczenia, który woła onClearFilters — koniec mylącego pustego stanu "brak nagrań".');
    const onClearFilters = vi.fn();
    render(<EventList events={[]} {...baseProps} hasActiveFilter onClearFilters={onClearFilters} />);
    expect(screen.getByText('events.emptyFiltered.title')).toBeInTheDocument();
    expect(screen.queryByText('events.emptyFirstTime.title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'events.clearFilters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
