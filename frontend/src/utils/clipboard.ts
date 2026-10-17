/**
 * Copy `text` to the clipboard. Resolves to whether it worked, so a caller only
 * confirms a copy that really happened.
 *
 * `navigator.clipboard` exists only in secure contexts (https, localhost). A
 * self-hosted install is often reached over plain http on the home network, so
 * when the async API is missing or refuses we fall back to selecting a hidden
 * field and `document.execCommand('copy')`, which still works there.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* permission refused — try the selection route */ }
  }
  return copyViaSelection(text);
}

function copyViaSelection(text: string): boolean {
  // Selecting the hidden field steals focus from the button that was pressed.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(field);
  // Whatever the user had selected before; put it back afterwards.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    field.focus({ preventScroll: true }); // select() alone does not always move focus
    field.select();
    field.setSelectionRange(0, text.length); // iOS ignores select() on its own
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    if (focused && focused !== document.body) focused.focus({ preventScroll: true });
  }
}
