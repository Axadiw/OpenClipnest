import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useServerConfig } from '../hooks/useServerConfig';
import { useTranslation } from '../i18n';
import { copyText } from '../utils/clipboard';

const COPIED_MS = 1500;
const T = 'events.emptyFirstTime.connect.';

/**
 * What to enter in a camera's FTP settings, for an account that has no
 * recordings yet: the server and port the server reports in GET /config, the
 * account e-mail as the user name, and notes on the password, the encryption
 * and passive mode.
 *
 * Renders nothing until /config has loaded, and on a server with passkeys: an
 * account there can have a separate FTP password, so "your account password"
 * would be wrong.
 */
export function CameraConnectionDetails() {
  const { t } = useTranslation();
  const config = useServerConfig();
  const { user } = useAuth();
  const headingId = useId();

  if (!config || config.features.passkeys || !config.ftps.host || !Number.isFinite(config.ftps.port) || !user?.email) {
    return null;
  }
  const { host, port } = config.ftps;

  return (
    <section className="camera-connect" data-testid="camera-connect" aria-labelledby={headingId}>
      <h3 id={headingId} className="camera-connect-title">{t(`${T}title`)}</h3>
      <dl className="camera-connect-list">
        <Row label={t(`${T}server`)} value={host} mono copy />
        <Row label={t(`${T}port`)} value={String(port)} mono copy />
        <Row label={t(`${T}username`)} value={user.email} mono copy />
        <Row label={t(`${T}password`)} value={t(`${T}passwordValue`)} />
        <Row label={t(`${T}encryption`)} value={t(`${T}encryptionValue`)} />
      </dl>
      <p className="camera-connect-hint">{t(`${T}passiveHint`, { host })}</p>
    </section>
  );
}

function Row({ label, value, mono = false, copy = false }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className="camera-connect-row">
      <dt>{label}</dt>
      <dd>
        <span className={mono ? 'camera-connect-value camera-connect-mono' : 'camera-connect-value'}>{value}</span>
        {copy && <CopyButton value={value} label={label} />}
      </dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    // Only confirm a copy that really happened.
    if (!(await copyText(value))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <>
      <button type="button" className="btn btn-sm camera-connect-copy" onClick={copy} aria-label={`${t(`${T}copy`)}: ${label}`}>
        {t(copied ? `${T}copied` : `${T}copy`)}
      </button>
      <span className="camera-connect-status" role="status">{copied ? t(`${T}copied`) : ''}</span>
    </>
  );
}
