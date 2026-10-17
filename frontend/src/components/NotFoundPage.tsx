import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="not-found-page" data-testid="not-found-page">
      <div className="not-found-card">
        <div className="not-found-code">404</div>
        <h1 className="not-found-title">{t('notFound.title')}</h1>
        <p className="not-found-body">{t('notFound.body')}</p>
        <Link className="btn" to="/" data-testid="not-found-home">
          {t('notFound.home')}
        </Link>
      </div>
    </div>
  );
}
