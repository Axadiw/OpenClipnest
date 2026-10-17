import { describe, it, expect } from 'vitest';
import { en } from './en';
import { pl } from './pl';
import { de } from './de';
import { fr } from './fr';
import { it as itCatalog } from './it';
import { es } from './es';
import { no } from './no';
import { tlh } from './tlh';

const catalogs = { pl, de, fr, it: itCatalog, es, no, tlh };

// English is the reference catalog and the runtime fallback (`t()` reads the
// active language, then English, then the key). Other languages may lag
// behind it, but must never carry keys English does not have — those are
// dead strings nobody can reach.
describe('core i18n catalogs', () => {
  it('never define a key that English lacks', () => {
    const reference = new Set(Object.keys(en));
    for (const [lang, catalog] of Object.entries(catalogs)) {
      const extra = Object.keys(catalog).filter((k) => !reference.has(k));
      expect(extra, lang).toEqual([]);
    }
  });

  it('keeps Polish (the second fully maintained language) in lockstep with English', () => {
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });
});
