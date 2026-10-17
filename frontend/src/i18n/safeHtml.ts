import DOMPurify from 'dompurify';

const ALLOWED = {
  ALLOWED_TAGS: ['strong', 'em', 'a', 'br', 'code'],
  ALLOWED_ATTR: ['href'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(https?:|\/|mailto:)/i,
};

export function tHtml(input: string): string {
  return DOMPurify.sanitize(input, ALLOWED);
}
