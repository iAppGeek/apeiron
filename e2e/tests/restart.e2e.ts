import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { Blotter } from '../support/blotter';

const run = promisify(execFile);
const root = new URL('../../', import.meta.url).pathname;
const API = 'http://127.0.0.1:4000';

const health = async (path: string): Promise<{ status: number; stage?: string } | null> => {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(1_500) });
    const body = (await res.json()) as { stage?: string };
    return { status: res.status, ...(body.stage === undefined ? {} : { stage: body.stage }) };
  } catch {
    return null;
  }
};

test.describe('blotter restart', () => {
  test('drains: says not ready, closes the sockets with 1012, and the page reconnects on its own', async ({ page }) => {
    test.setTimeout(240_000);
    const blotter = new Blotter(page);
    await blotter.open();
    await expect(blotter.connection).toHaveText('Connected');

    const socket = new WebSocket('ws://127.0.0.1:4000/ws');
    const closed = new Promise<{ code: number; ms: number }>((resolve) => {
      const opened = Date.now();
      socket.onclose = (event): void => resolve({ code: event.code, ms: Date.now() - opened });
    });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = (): void => resolve();
      socket.onerror = (): void => reject(new Error('could not connect'));
    });
    socket.send(JSON.stringify({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'restart-e2e' }));

    const restarted = run('docker', ['compose', '--profile', 'core', 'restart', 'antikythera'], { cwd: root });
    const seen: string[] = [];
    let live = true;
    void restarted.finally(() => {
      live = false;
    });
    while (live) {
      const ready = await health('/health/ready');
      if (ready?.stage !== undefined) seen.push(`${ready.status}:${ready.stage}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await restarted;

    const { code } = await closed;
    expect(code).toBe(1012);
    // Before the process went away it said it was draining (503), and it was live throughout.
    expect(seen).toContain('503:draining');

    await expect.poll(async () => (await health('/health/ready'))?.status, { timeout: 120_000 }).toBe(200);
    await expect(blotter.connection).toHaveText('Connected', { timeout: 60_000 });
    await expect(blotter.orderRows.first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
