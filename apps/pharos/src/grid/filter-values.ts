import { RequestError, type BlotterClient } from '../transport/client';
import { isRetryable } from './errors';

export type FilterValuesOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Set filter values for a column. Waits out NOT_READY and a dropped link a few times before giving up,
 * so a filter opened during startup or a reconnect still gets its list.
 */
export async function fetchFilterValues(
  client: Pick<BlotterClient, 'setFilterValues'>,
  colId: string,
  options: FilterValuesOptions = {},
): Promise<string[]> {
  const attempts = options.attempts ?? 6;
  const sleep = options.sleep ?? defaultSleep;
  let delay = options.delayMs ?? 400;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.setFilterValues(colId);
    } catch (error) {
      const retryable = error instanceof RequestError && isRetryable(error.code);
      if (!retryable || attempt >= attempts) throw error;
      await sleep(delay);
      delay = Math.min(5000, delay * 2);
    }
  }
}
