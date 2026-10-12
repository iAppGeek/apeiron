import { randomUUID } from 'node:crypto';
import {
  BUCKETS,
  CONSUMERS,
  STREAMS,
  SUBJECTS,
  parseOrderCommand,
  mulberry32,
  parseLoadControl,
  parseOrderStateRecord,
  parsePriceTick,
  parseSubmitReply,
  type LoadState,
  type Bus,
  type BusSubscription,
  type KvWatch,
  type LoadPreset,
  type Order,
  type OrderEvent,
  type OrderStateRecord,
} from '@apeiron/logos';
import type { Logger } from './log.js';
import type { HermesMetrics } from './metrics.js';
import { QuoteBook } from './quotes.js';
import { Simulator, nextSeqFrom, type ReportSink } from './simulator.js';

export type HermesOptions = {
  bus: Bus;
  log: Logger;
  preset: LoadPreset;
  /** `loadCurrent()` result. */
  current: readonly Order[];
  /** `maxOrderId()` result. */
  maxOrderId: string | null;
  seed: number;
  stepMs: number;
  /**
   * `events` (default): publish `orders.events`, hold the orders from `current`. `reports`: send submissions and execution
   * reports to the order service, and load the open orders from it (`current` and `maxOrderId` are not used).
   */
  execMode?: 'events' | 'reports';
  /** Most time to wait at startup for a quote for every pair (default 10 s); the rest use their reference level. */
  priceWaitMs?: number;
  now?: () => number;
  metrics?: HermesMetrics;
};

export type HermesStatus = {
  status: 'ok' | 'stopped';
  preset: LoadPreset;
  live: number;
  pending: number;
  eventsPublished: number;
  commandsHandled: number;
  publishErrors: number;
  inflight: number;
};

/** How often hermes repeats `control.state`, so a server that starts later learns the preset within this long. */
export const STATE_INTERVAL_MS = 5_000;

/** A command older than this when hermes sees it is dropped: the server has already timed it out. */
export const COMMAND_MAX_AGE_MS = 30_000;

/** Publishes beyond this many unacknowledged messages are held back until the backlog drains. */
export const MAX_INFLIGHT = 20_000;

/** How long a submission waits for the order service's reply, and the open-orders query at startup. */
export const SUBMIT_TIMEOUT_MS = 10_000;
export const QUERY_TIMEOUT_MS = 30_000;

export type Hermes = {
  stop(): Promise<void>;
  status(): HermesStatus;
  simulator: Simulator;
  /** The latest quote of each pair, from the price feed. */
  quotes: QuoteBook;
};

/**
 * Wires the lifecycle simulator to a bus: follows the price feed (`prices.*`) for fill prices and market snapshots,
 * reconciles stale orders at startup, publishes `orders.events` at the preset rate, and follows `control.load`. It makes
 * no prices of its own.
 */
export async function startHermes(options: HermesOptions): Promise<Hermes> {
  const { bus, log } = options;
  const now = options.now ?? ((): number => Date.now());
  const rng = mulberry32(options.seed);
  const quotes = new QuoteBook();
  let eventsPublished = 0;
  let publishErrors = 0;
  let inflight = 0;
  let stopped = false;

  /** Resolves true once the broker has the message, false if the publish failed. Never rejects. */
  const publish = (subject: string, payload: unknown): Promise<boolean> => {
    inflight++;
    return bus
      .publish(subject, payload)
      .then(() => {
        eventsPublished++;
        options.metrics?.event((payload as OrderEvent).type);
        return true;
      })
      .catch((error: unknown) => {
        publishErrors++;
        options.metrics?.publishError();
        if (publishErrors === 1 || publishErrors % 1000 === 0) log.warn({ err: error, publishErrors }, 'publish failed');
        return false;
      })
      .finally(() => {
        inflight--;
      });
  };

  let lastEventPublish: Promise<boolean> | null = null;
  const reportsMode = options.execMode === 'reports';

  const reportSink: ReportSink = {
    report: (report): void => {
      lastEventPublish = publish(SUBJECTS.execReports, report);
    },
    answer: (answer): void => {
      lastEventPublish = publish(SUBJECTS.ordersAnswers, answer);
    },
    submit: async (submission) => {
      inflight++;
      try {
        const parsed = parseSubmitReply(await bus.request(SUBJECTS.ordersSubmit, submission, SUBMIT_TIMEOUT_MS));
        if (!parsed.ok) throw new Error(`unreadable submit reply: ${parsed.error}`);
        return parsed.value;
      } catch (error) {
        publishErrors++;
        options.metrics?.publishError();
        if (publishErrors === 1 || publishErrors % 1000 === 0) log.warn({ err: error, publishErrors }, 'submission failed');
        throw error;
      } finally {
        inflight--;
      }
    },
  };

  const simulator = new Simulator({
    rng,
    feed: quotes,
    preset: options.preset,
    current: reportsMode ? [] : options.current,
    startSeq: reportsMode ? 0 : nextSeqFrom(options.maxOrderId),
    ...(reportsMode
      ? { reports: reportSink }
      : {
          emit: (event: OrderEvent): void => {
            lastEventPublish = publish(SUBJECTS.ordersEvents, event);
          },
        }),
  });

  // `reports` mode: follow the order service's records of the orders. The watch is opened before the open orders are
  // asked for, so nothing between the two is missed; whatever it delivered meanwhile is applied afterwards, and a record
  // is applied only if its version is above the one already held.
  const heldVersions = new Map<string, number>();
  const adopt = (record: OrderStateRecord): void => {
    const id = record.order.orderId;
    if ((heldVersions.get(id) ?? 0) >= record.v) return;
    heldVersions.set(id, record.v);
    simulator.syncRecord(record);
  };
  const buffered: OrderStateRecord[] = [];
  let following = false;
  let watch: KvWatch | null = null;
  let inboxSub: BusSubscription | null = null;
  if (reportsMode) {
    // The bucket belongs to the order service, which may still be starting.
    let kvWatch: KvWatch | null = null;
    for (let attempt = 1; kvWatch === null; attempt++) {
      try {
        kvWatch = await bus.kv(BUCKETS.orderState).watch({ updatesOnly: true });
      } catch (error) {
        if (attempt >= 30) throw error;
        log.warn({ err: error, attempt }, 'could not watch the order state yet, retrying');
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    }
    watch = kvWatch;
    const orderState = kvWatch;
    void (async (): Promise<void> => {
      for await (const entry of orderState) {
        if (entry.op !== 'PUT') continue;
        const parsed = parseOrderStateRecord(entry.value);
        if (!parsed.ok) continue;
        if (following) adopt(parsed.value);
        else buffered.push(parsed.value);
      }
    })().catch((error: unknown) => log.warn({ err: error }, 'order-state watch ended'));
  }

  // Prices first, so reconciliation fills and new orders use the market: follow the feed, take the last quote of
  // every pair, and give a feed that is still starting a moment to publish.
  const prices = await bus.subscribe(SUBJECTS.pricesWildcard, (payload) => {
    const parsed = parsePriceTick(payload);
    if (parsed.ok) quotes.update(parsed.value);
  });
  try {
    for (const message of await bus.lastPerSubject(STREAMS.prices, SUBJECTS.pricesWildcard)) {
      const parsed = parsePriceTick(message.payload);
      if (parsed.ok) quotes.update(parsed.value);
    }
  } catch (error) {
    log.warn({ err: error }, 'could not read the last prices');
  }
  const priceDeadline = Date.now() + (options.priceWaitMs ?? 10_000);
  while (quotes.missing().length > 0 && Date.now() < priceDeadline) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (quotes.missing().length > 0) log.warn({ missing: quotes.missing() }, 'starting without a quote for some pairs; using their reference levels');

  if (reportsMode) {
    const inbox = `inbox.hermes.${randomUUID().replaceAll('-', '')}`;
    const chunks: { records: unknown[] }[] = [];
    inboxSub = await bus.subscribe(inbox, (payload) => {
      chunks.push(payload as { records: unknown[] });
    });
    let expected = -1;
    for (let attempt = 1; expected < 0; attempt++) {
      try {
        const reply = (await bus.request(SUBJECTS.ordersQueryOpen, { inbox }, QUERY_TIMEOUT_MS)) as { chunks: number };
        expected = reply.chunks;
      } catch (error) {
        if (attempt >= 30) throw error;
        log.warn({ err: error, attempt }, 'could not ask the order service for the open orders yet, retrying');
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    }
    for (let waited = 0; chunks.length < expected && waited < 100; waited++) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    let loaded = 0;
    for (const chunk of chunks) {
      for (const raw of chunk.records) {
        const parsed = parseOrderStateRecord(raw);
        if (parsed.ok) {
          adopt(parsed.value);
          loaded++;
        }
      }
    }
    following = true;
    for (const record of buffered.splice(0)) adopt(record);
    log.info({ loaded, chunks: chunks.length }, 'loaded the open orders from the order service');
  }

  const reconciled = simulator.reconcile(now());
  log.info(
    { ...reconciled, live: simulator.liveCount, pending: simulator.pendingCount, preset: simulator.preset },
    'reconciled current orders',
  );

  const publishState = (): void => {
    const state: LoadState = { preset: simulator.preset };
    bus.publish(SUBJECTS.controlState, state).catch((error: unknown) => {
      log.warn({ err: error }, 'publish control.state failed');
    });
  };
  publishState();
  const stateTimer = setInterval(publishState, STATE_INTERVAL_MS);

  let control: BusSubscription | null = null;
  control = await bus.subscribe(SUBJECTS.controlLoad, (payload) => {
    const parsed = parseLoadControl(payload);
    if (!parsed.ok) {
      log.warn({ error: parsed.error }, 'ignored invalid control.load message');
      return;
    }
    simulator.setPreset(parsed.value.preset, now());
    log.info({ preset: parsed.value.preset, live: simulator.liveCount }, 'load preset changed');
    publishState();
  });

  let commandsHandled = 0;
  const commands = await bus.consume(
    { stream: STREAMS.orders, durable: CONSUMERS.hermesCommands, subject: SUBJECTS.ordersCommands },
    (payload, _subject, ack) => {
      const parsed = parseOrderCommand(payload);
      if (!parsed.ok) {
        log.warn({ error: parsed.error }, 'dropped invalid order command');
        ack();
        return;
      }
      const command = parsed.value;
      const t = now();
      if (t - command.ts > COMMAND_MAX_AGE_MS) {
        log.warn({ commandId: command.commandId, ageMs: t - command.ts }, 'dropped stale order command');
        ack();
        return;
      }
      lastEventPublish = null;
      simulator.command(command, t);
      commandsHandled++;
      options.metrics?.commandHandled();
      // Acknowledge only once the answering event is on the stream; otherwise the command is redelivered.
      void (lastEventPublish ?? Promise.resolve(true)).then((published) => {
        if (published) ack();
      });
    },
  );

  let last = now();
  const timer = setInterval(() => {
    if (stopped) return;
    const t = now();
    const dt = Math.min(t - last, 1_000);
    last = t;
    if (inflight > MAX_INFLIGHT) {
      log.warn({ inflight }, 'publish backlog, skipping simulation step');
      return;
    }
    simulator.step(t, dt);
  }, options.stepMs);

  const status = (): HermesStatus => ({
      status: stopped ? 'stopped' : 'ok',
      preset: simulator.preset,
      live: simulator.liveCount,
      pending: simulator.pendingCount,
      eventsPublished,
      commandsHandled,
      publishErrors,
      inflight,
    });
  options.metrics?.bind(() => {
    const s = status();
    return { preset: s.preset, live: s.live, pending: s.pending, inflight: s.inflight };
  });

  return {
    simulator,
    quotes,
    status,
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      clearInterval(stateTimer);
      await control?.close();
      await prices.close();
      await commands.close();
      await watch?.close();
      await inboxSub?.close();
    },
  };
}
