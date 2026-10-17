import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from './clipboard';
import { story } from '../test-story';

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

function stubExecCommand(impl: (cmd: string) => boolean) {
  const fn = vi.fn(impl);
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true, writable: true });
  return fn;
}

afterEach(() => {
  stubClipboard(undefined);
  Reflect.deleteProperty(document, 'execCommand');
  document.body.innerHTML = '';
});

describe('copyText', () => {
  it('uses the async clipboard API when the browser offers it', async (ctx) => {
    story(ctx, 'Na stronie przez HTTPS (lub localhost) przycisk "Kopiuj" używa zwykłego API schowka — użytkownik dostaje wartość w schowku jednym kliknięciem.');
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const execCommand = stubExecCommand(() => true);

    await expect(copyText('192.168.1.10')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('192.168.1.10');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to selecting a hidden field when there is no async clipboard (plain-http install)', async (ctx) => {
    story(ctx, 'Self-hosted bywa wystawiony po zwykłym HTTP w sieci domowej, gdzie przeglądarka nie udostępnia navigator.clipboard — kopiowanie nadal działa dzięki zaznaczeniu ukrytego pola, a po wszystkim po polu nie zostaje ślad w stronie.');
    stubClipboard(undefined);
    let copied = '';
    const execCommand = stubExecCommand((cmd) => {
      copied = (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '';
      return cmd === 'copy';
    });

    await expect(copyText('viewer@example.test')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toBe('viewer@example.test');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to the hidden field when the async clipboard refuses', async (ctx) => {
    story(ctx, 'Gdy przeglądarka odrzuci zapis do schowka (brak uprawnienia), kopiowanie próbuje jeszcze drogi przez zaznaczenie zamiast cicho nie zadziałać.');
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });
    const execCommand = stubExecCommand(() => true);

    await expect(copyText('21')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('hands focus back to the element that had it after the fallback copy', async (ctx) => {
    story(ctx, 'Kopiowanie przez zaznaczenie ukrytego pola zabiera fokus przyciskowi, który użytkownik właśnie wcisnął. Bez jego przywrócenia klawiatura i czytnik ekranu lądują na <body>, a kolejny Tab zaczyna się od początku strony — po skopiowaniu fokus ma zostać tam, gdzie był.');
    stubClipboard(undefined);
    let focusedDuringCopy: Element | null = null;
    stubExecCommand(() => {
      focusedDuringCopy = document.activeElement;
      return true;
    });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    await expect(copyText('192.168.1.10')).resolves.toBe(true);

    expect(focusedDuringCopy).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement).toBe(button);
  });

  it('restores focus even when the fallback copy fails', async (ctx) => {
    story(ctx, 'Nieudane kopiowanie też nie może zostawić użytkownika bez fokusu — po błędzie przycisk, z którego kliknął, nadal jest aktywnym elementem.');
    stubClipboard(undefined);
    stubExecCommand(() => { throw new Error('unsupported'); });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await expect(copyText('secret')).resolves.toBe(false);

    expect(document.activeElement).toBe(input);
  });

  it('reports failure, and cleans up, when nothing can copy', async (ctx) => {
    story(ctx, 'Jeśli żadna droga kopiowania nie działa, funkcja uczciwie zwraca false — interfejs nie pokaże "Skopiowano", gdy nic nie trafiło do schowka.');
    stubClipboard(undefined);
    stubExecCommand(() => { throw new Error('unsupported'); });

    await expect(copyText('secret')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
