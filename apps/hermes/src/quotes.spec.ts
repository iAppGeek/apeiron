import { PAIR_BY_NAME } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { QuoteBook } from './quotes.js';

describe('QuoteBook', () => {
  it('answers a pair with no quote with its reference level and says which pairs are missing', () => {
    const book = new QuoteBook();
    expect(book.mid('EURUSD')).toBe(PAIR_BY_NAME.get('EURUSD')?.mid);
    expect(book.quote('EURUSD')).toBeUndefined();
    expect(book.size).toBe(0);
    expect(book.missing()).toHaveLength(20);
  });

  it('holds the latest tick of each pair and its mid', () => {
    const book = new QuoteBook();
    book.update({ pair: 'EURUSD', bid: 1.1, ask: 1.3, ts: 5 });
    expect(book.mid('EURUSD')).toBeCloseTo(1.2, 10);
    expect(book.quote('EURUSD')).toMatchObject({ ts: 5 });
    expect(book.size).toBe(1);
    expect(book.missing()).not.toContain('EURUSD');
  });

  it('ignores a tick older than the one it holds, and accepts an equal or newer one', () => {
    const book = new QuoteBook();
    book.update({ pair: 'EURUSD', bid: 1, ask: 1, ts: 10 });
    book.update({ pair: 'EURUSD', bid: 9, ask: 9, ts: 9 });
    expect(book.mid('EURUSD')).toBe(1);
    book.update({ pair: 'EURUSD', bid: 2, ask: 2, ts: 10 });
    expect(book.mid('EURUSD')).toBe(2);
    book.update({ pair: 'EURUSD', bid: 3, ask: 3, ts: 11 });
    expect(book.mid('EURUSD')).toBe(3);
  });
});
