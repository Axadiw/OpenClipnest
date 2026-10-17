import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { VideoZoom } from './VideoZoom';
import { canStep } from '../lib/frameStep';
import { story } from '../test-story';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

// happy-dom can't decode real media, so the <video> element is faked. Only
// the element is faked — the component's listeners, handlers and rendering
// (the actual unit under test) are real.
class FakeVideo extends EventTarget {
  currentTime = 0;
  duration = NaN;
}

const grid = [0, 0.067, 0.2, 0.267]; // irregular VFR grid

function setup(overrides: Partial<FakeVideo> = {}) {
  const video = Object.assign(new FakeVideo(), overrides);
  const videoRef = createRef<HTMLVideoElement>();
  (videoRef as { current: unknown }).current = video;

  const onStep = vi.fn();
  const canStepFrame = (dir: 1 | -1) =>
    isFinite(video.duration) && canStep(grid, video.currentTime, dir, 15, video.duration);

  const utils = render(
    <VideoZoom videoRef={videoRef} onStep={onStep} canStep={canStepFrame}>
      <div />
    </VideoZoom>,
  );
  return { video, onStep, ...utils };
}

describe('VideoZoom frame-step buttons', () => {
  it('enables both step buttons mid-video', (ctx) => {
    story(ctx, 'W środku nagrania oba przyciski klatka-po-klatce są aktywne — użytkownik może przesuwać się w obie strony.');
    setup({ currentTime: 0.2, duration: 10 });
    expect(screen.getByTestId('player-step-back')).toBeEnabled();
    expect(screen.getByTestId('player-step-forward')).toBeEnabled();
  });

  it('disables step-back at the very start of the video', (ctx) => {
    story(ctx, 'Na pierwszej klatce przycisk "klatka wstecz" jest wyszarzony — kliknięcie i tak by nic nie zmieniło, więc UI nie udaje, że zmieni.');
    setup({ currentTime: 0, duration: 10 });
    expect(screen.getByTestId('player-step-back')).toBeDisabled();
    expect(screen.getByTestId('player-step-forward')).toBeEnabled();
  });

  it('disables step-forward on the last frame even though duration is larger', (ctx) => {
    story(ctx, 'Na ostatniej klatce przycisk "klatka dalej" jest wyszarzony, mimo że metadane klipu zgłaszają dłuższy czas trwania — liczy się realna siatka klatek, nie duration.');
    setup({ currentTime: 0.267, duration: 10 });
    expect(screen.getByTestId('player-step-forward')).toBeDisabled();
    expect(screen.getByTestId('player-step-back')).toBeEnabled();
  });

  it('re-evaluates the buttons as the video plays (timeupdate)', (ctx) => {
    story(ctx, 'Gdy odtwarzanie ruszy z pierwszej klatki, przycisk "klatka wstecz" odblokowuje się na bieżąco — stan przycisków podąża za pozycją wideo.');
    const { video } = setup({ currentTime: 0, duration: 10 });
    expect(screen.getByTestId('player-step-back')).toBeDisabled();
    act(() => { video.currentTime = 0.2; video.dispatchEvent(new Event('timeupdate')); });
    expect(screen.getByTestId('player-step-back')).toBeEnabled();
  });

  it('stays disabled before metadata and enables once duration arrives', (ctx) => {
    story(ctx, 'Zanim przeglądarka pozna metadane klipu, przyciski są wyszarzone (krok i tak byłby ignorowany) — aktywują się dopiero po loadedmetadata.');
    const { video } = setup({ currentTime: 0.2 });
    expect(screen.getByTestId('player-step-forward')).toBeDisabled();
    act(() => { video.duration = 10; video.dispatchEvent(new Event('loadedmetadata')); });
    expect(screen.getByTestId('player-step-forward')).toBeEnabled();
  });

  it('does not fire onStep from a disabled button', (ctx) => {
    story(ctx, 'Kliknięcie wyszarzonego przycisku nie wywołuje kroku — nie ma ukrytych przeskoków pozycji z martwego przycisku.');
    const { onStep } = setup({ currentTime: 0, duration: 10 });
    fireEvent.click(screen.getByTestId('player-step-back'));
    expect(onStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('player-step-forward'));
    expect(onStep).toHaveBeenCalledWith(1);
  });
});
