import { useEffect } from 'react';

export type ToastTone = 'error' | 'warn';

interface Props {
  message: string;
  tone?: ToastTone;
  durationMs?: number;
  onClose: () => void;
}

export function Toast({ message, tone = 'error', durationMs = 5000, onClose }: Props) {
  useEffect(() => {
    const id = window.setTimeout(onClose, durationMs);
    return () => window.clearTimeout(id);
  }, [durationMs, onClose]);

  return (
    <div className={`toast toast-${tone}`} role="status" aria-live="polite">
      <span className="toast-msg">{message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={onClose}
        aria-label="Dismiss"
      >×</button>
    </div>
  );
}
