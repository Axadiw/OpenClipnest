// Pure helpers for the changelog-screenshots tool. Kept separate from
// run.ts so unit tests don't drag in Playwright. The runner imports these
// to keep the contract with the backend filename regex airtight.

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'as', 'so',
]);

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Pull 3-4 meaningful words off the front of a bullet, kebab-case them,
 * cap at 40 chars without breaking a word. Falls back to "feature" if
 * the input is empty or punctuation-only.
 */
export function slugify(text: string): string {
  const words = (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])
    .filter(w => !STOP_WORDS.has(w));
  if (words.length === 0) return 'feature';
  const picked: string[] = [];
  let length = 0;
  for (const w of words.slice(0, 4)) {
    const next = length === 0 ? w.length : length + 1 + w.length;
    if (next > 40) break;
    picked.push(w);
    length = next;
  }
  if (picked.length === 0) {
    // First word alone exceeds 40 chars — truncate it hard.
    return words[0].slice(0, 40);
  }
  return picked.join('-');
}

/**
 * Build a filename matching the backend's strict regex
 * `^v\d+\.\d+\.\d+-\d+-[a-z0-9-]+\.png$`. Throws if the inputs would
 * produce a name the backend would reject — fail fast at the producer.
 */
export function formatScreenshotFilename(tag: string, bulletIndex: number, slug: string): string {
  if (!TAG_RE.test(tag)) {
    throw new Error(`Invalid tag (expected vMAJ.MIN.PATCH): ${tag}`);
  }
  if (!Number.isInteger(bulletIndex) || bulletIndex < 1) {
    throw new Error(`Invalid bulletIndex (must be >= 1): ${bulletIndex}`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug (must be kebab-case [a-z0-9-]+): ${slug}`);
  }
  return `${tag}-${bulletIndex}-${slug}.png`;
}

export type Viewport = 'desktop' | 'mobile';

export function viewportSize(viewport: Viewport): { width: number; height: number } {
  if (viewport === 'desktop') return { width: 1280, height: 800 };
  if (viewport === 'mobile') return { width: 390, height: 844 };
  throw new Error(`Unknown viewport: ${viewport}`);
}

export interface ConfigEntry {
  tag: string;
  bulletIndex: number;
  slug: string;
  url: string;
  selector: string;
  viewport: Viewport;
}

export function validateConfigEntry(entry: ConfigEntry): void {
  if (!TAG_RE.test(entry.tag)) throw new Error(`bad tag: ${entry.tag}`);
  if (!Number.isInteger(entry.bulletIndex) || entry.bulletIndex < 1) {
    throw new Error(`bad bulletIndex: ${entry.bulletIndex}`);
  }
  if (!SLUG_RE.test(entry.slug)) throw new Error(`bad slug: ${entry.slug}`);
  // Path only — no protocol, no protocol-relative `//`. The runner
  // prepends the local base URL itself.
  if (typeof entry.url !== 'string' || !entry.url.startsWith('/') || entry.url.startsWith('//')) {
    throw new Error(`url must be a path starting with a single slash: ${entry.url}`);
  }
  if (typeof entry.selector !== 'string' || entry.selector.trim() === '') {
    throw new Error(`empty selector`);
  }
  if (entry.viewport !== 'desktop' && entry.viewport !== 'mobile') {
    throw new Error(`bad viewport: ${entry.viewport}`);
  }
}
