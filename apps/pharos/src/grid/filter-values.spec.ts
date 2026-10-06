import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../transport/client';
import { fetchFilterValues } from './filter-values';

const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

describe('fetchFilterValues', () => {
  it('returns the values from setFilterValues', async () => {
    const client = { setFilterValues: vi.fn().mockResolvedValue(['A', 'B']) };
    await expect(fetchFilterValues(client, 'venue', { sleep })).resolves.toEqual(['A', 'B']);
    expect(client.setFilterValues).toHaveBeenCalledWith('venue');
  });

  it('retries NOT_READY and then succeeds', async () => {
    sleep.mockClear();
    const client = {
      setFilterValues: vi
        .fn()
        .mockRejectedValueOnce(new RequestError({ code: 'NOT_READY', message: 'x' }))
        .mockResolvedValue(['LIVE']),
    };
    await expect(fetchFilterValues(client, 'status', { sleep, delayMs: 50 })).resolves.toEqual(['LIVE']);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('gives up after the attempt limit', async () => {
    const error = new RequestError({ code: 'DISCONNECTED', message: 'gone' });
    const client = { setFilterValues: vi.fn().mockRejectedValue(error) };
    await expect(fetchFilterValues(client, 'status', { sleep, attempts: 3 })).rejects.toBe(error);
    expect(client.setFilterValues).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const error = new RequestError({ code: 'UNKNOWN_COLUMN', message: 'nope' });
    const client = { setFilterValues: vi.fn().mockRejectedValue(error) };
    await expect(fetchFilterValues(client, 'zzz', { sleep })).rejects.toBe(error);
    expect(client.setFilterValues).toHaveBeenCalledTimes(1);
  });
});
