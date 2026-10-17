import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';
import { story } from '../test-story';

// Suppress React's intentional console.error for caught errors in tests.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const BrokenChild = () => {
  throw new Error('boom');
  return null;
};

describe('ErrorBoundary', () => {
  it('renders children when there is no error', (ctx) => {
    story(ctx, 'Normalny render bez błędu — ErrorBoundary jest transparentny, dzieci widoczne.');
    render(
      <ErrorBoundary>
        <div>wszystko ok</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('wszystko ok')).toBeInTheDocument();
  });

  it('renders default fallback when a child throws', (ctx) => {
    story(ctx, 'Dziecko rzuca wyjątek — ErrorBoundary łapie go i pokazuje fallback zamiast białego ekranu.');
    render(
      <ErrorBoundary>
        <BrokenChild />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders custom fallback when provided', (ctx) => {
    story(ctx, 'Custom fallback przekazany przez rodzica — ErrorBoundary renderuje go zamiast domyślnego komunikatu.');
    render(
      <ErrorBoundary fallback={<div>własny fallback</div>}>
        <BrokenChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText('własny fallback')).toBeInTheDocument();
  });
});
