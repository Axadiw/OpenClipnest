import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Toast } from './Toast';
import { story } from '../test-story';

describe('Toast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders message and dismiss button', (ctx) => {
    story(ctx, 'Toast pokazuje treść i przycisk × — nie blokuje renderera jak natywny alert(), więc reszta UI dalej działa.');
    const onClose = vi.fn();
    render(<Toast message="server down" onClose={onClose} />);
    expect(screen.getByText('server down')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('auto-dismisses after default duration', (ctx) => {
    story(ctx, 'Toast sam znika po 5s — user nie musi go klikać żeby kontynuować pracę, w odróżnieniu od alert() który blokował.');
    const onClose = vi.fn();
    render(<Toast message="x" onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('respects custom duration', (ctx) => {
    story(ctx, 'Duration jest konfigurowalne — pozwala dostroić czas pokazywania pod typ komunikatu (krótki info vs ważny błąd).');
    const onClose = vi.fn();
    render(<Toast message="x" durationMs={2000} onClose={onClose} />);
    act(() => { vi.advanceTimersByTime(1999); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('applies tone class', (ctx) => {
    story(ctx, 'Tone (error/warn) mapuje na klasę CSS, dzięki czemu wizualnie odróżniamy transient error (czerwony) od soft warning (żółty).');
    const { container } = render(<Toast message="x" tone="warn" onClose={() => {}} />);
    expect(container.querySelector('.toast-warn')).toBeInTheDocument();
  });
});
