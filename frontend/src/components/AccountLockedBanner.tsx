import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';

/** Shown above the content while the account is access-locked. */
export function AccountLockedBanner({ locked, action }: { locked: boolean; action?: ReactNode }) {
  const { t } = useTranslation();
  if (!locked) return null;
  return (
    <div role="status" className="account-locked-banner">
      <span>{t('account.lockedBanner')}</span>
      {action ? <span className="account-locked-action">{action}</span> : null}
    </div>
  );
}
