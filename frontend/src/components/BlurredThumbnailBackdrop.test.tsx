import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BlurredThumbnailBackdrop } from './BlurredThumbnailBackdrop';
import { story } from '../test-story';

const fetchThumbnailBlob = vi.fn();

vi.mock('../api', () => ({
  api: {
    fetchThumbnailBlob: (...args: unknown[]) => fetchThumbnailBlob(...args),
  },
}));

beforeEach(() => {
  fetchThumbnailBlob.mockReset();
  // jsdom doesn't implement createObjectURL/revokeObjectURL.
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:mock');
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
});

describe('BlurredThumbnailBackdrop', () => {
  it('renders the blurred thumbnail image once the blob resolves', async (ctx) => {
    story(ctx, 'Zamiast czarnej dziury w trakcie ładowania wideo, użytkownik dostaje rozblurrowaną miniaturę — szybki sygnał "to ten klip, który kliknąłeś, już się ładuje".');
    fetchThumbnailBlob.mockResolvedValueOnce('blob:thumb-abc');
    render(<BlurredThumbnailBackdrop eventId="evt-1" visible={true} />);
    const img = await waitFor(() => {
      const found = document.querySelector('.blurred-thumbnail-backdrop img');
      if (!found) throw new Error('img not yet rendered');
      return found as HTMLImageElement;
    });
    expect(img).toHaveAttribute('src', 'blob:thumb-abc');
  });

  it('keeps the solid-black fallback when the thumbnail endpoint fails', async (ctx) => {
    story(ctx, 'Jeśli miniatura jeszcze nie wygenerowała się po stronie backendu (404), tło pozostaje czarne — żadnego błyskania ani widocznego błędu, po prostu klasyczne zachowanie sprzed feature\'a.');
    fetchThumbnailBlob.mockRejectedValueOnce(new Error('not ready'));
    render(<BlurredThumbnailBackdrop eventId="evt-1" visible={true} />);
    // Wait one tick to let the rejection settle.
    await waitFor(() => expect(fetchThumbnailBlob).toHaveBeenCalled());
    expect(document.querySelector('.blurred-thumbnail-backdrop img')).toBeNull();
    const root = screen.getByTestId('blurred-thumbnail-backdrop');
    expect(root).toBeInTheDocument();
    expect(root.className).not.toContain('is-hidden');
  });

  it('applies the is-hidden modifier when visible=false', (ctx) => {
    story(ctx, 'Gdy pierwsza klatka się załaduje, backdrop dostaje klasę is-hidden i CSS-em znika z fadem — wideo gładko przejmuje cały kadr bez gwałtownej zmiany.');
    fetchThumbnailBlob.mockResolvedValueOnce('blob:thumb-abc');
    render(<BlurredThumbnailBackdrop eventId="evt-1" visible={false} />);
    const root = screen.getByTestId('blurred-thumbnail-backdrop');
    expect(root.className).toContain('is-hidden');
  });

  it('refetches when eventId changes (timeline switches clip)', async (ctx) => {
    story(ctx, 'W Timeline kliknięcie kolejnego eventa zmienia eventId — komponent natychmiast pobiera nową miniaturę, więc przy każdej zmianie wideo użytkownik widzi właściwą rozblurrowaną klatkę, a nie poprzednią.');
    fetchThumbnailBlob.mockResolvedValueOnce('blob:thumb-first');
    const { rerender } = render(<BlurredThumbnailBackdrop eventId="evt-1" visible={true} />);
    await waitFor(() => {
      const img = document.querySelector('.blurred-thumbnail-backdrop img') as HTMLImageElement | null;
      expect(img?.src).toContain('thumb-first');
    });
    expect(fetchThumbnailBlob).toHaveBeenCalledWith('evt-1');

    fetchThumbnailBlob.mockResolvedValueOnce('blob:thumb-second');
    rerender(<BlurredThumbnailBackdrop eventId="evt-2" visible={true} />);
    await waitFor(() => expect(fetchThumbnailBlob).toHaveBeenCalledWith('evt-2'));
    await waitFor(() => {
      const img = document.querySelector('.blurred-thumbnail-backdrop img') as HTMLImageElement | null;
      expect(img?.src).toContain('thumb-second');
    });
  });
});
