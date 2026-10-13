import type { Browser, Page } from '@playwright/test';
import { Blotter } from './blotter';

export type UserPage = { page: Page; blotter: Blotter };

/** Opens the app as `user` in its own browser context and waits until it shows rows. */
export async function openAs(browser: Browser, user: string): Promise<UserPage> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const blotter = new Blotter(page);
  await blotter.open(user);
  return { page, blotter };
}

/**
 * Says hello as `userId` on a raw socket opened from the page, sends one message and returns the first `ack` or `error`.
 * The message gets `reqId: 1`. This is how a client that skips the UI (or forges it) would talk to the server.
 */
export async function sendRaw(page: Page, userId: string, message: Record<string, unknown>): Promise<{ t: string; code?: string; message?: string }> {
  return page.evaluate(
    ({ user, body }) =>
      new Promise<{ t: string; code?: string; message?: string }>((resolve, reject) => {
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        const timer = setTimeout(() => reject(new Error('no answer to the raw message')), 10_000);
        socket.onopen = (): void => {
          socket.send(JSON.stringify({ t: 'hello', userId: user, traderId: 'ALL', codec: 'json', clientId: `raw-${Math.random()}` }));
        };
        socket.onmessage = (event): void => {
          const msg = JSON.parse(String(event.data)) as { t: string; code?: string; message?: string };
          if (msg.t === 'welcome') socket.send(JSON.stringify({ ...body, reqId: 1 }));
          else if (msg.t === 'error' || msg.t === 'ack') {
            clearTimeout(timer);
            socket.close();
            resolve(msg);
          }
        };
      }),
    { user: userId, body: message },
  );
}
