import { describe, expect, it } from 'vitest';
import {
  derivePriceFields,
  applyFill,
  pnlUsdOf,
  slippageBpsOf,
  transition,
  applyCommand,
  availableCommands,
  canApplyCommand,
  canTransition,
  COMMAND_TARGET,
} from './lifecycle.js';
import { sampleOrders } from './fixtures.js';
import type { Order } from './order.js';

const NOW = 1_800_000_000_000;

function liveOrder(overrides: Partial<Order> = {}): Order {
  const base = sampleOrders(1)[0] as Order;
  return {
    ...base,
    currencyPair: 'EURUSD',
    side: 'BUY',
    status: 'LIVE',
    orderQty: 1_000_000,
    filledQty: 0,
    remainingQty: 1_000_000,
    pctComplete: 0,
    notionalUsd: 1_080_000,
    filledNotionalUsd: 0,
    arrivalPrice: 1.08,
    avgFillPrice: null,
    lastFillPrice: null,
    lastFillQty: 0,
    numFills: 0,
    numChildOrders: 0,
    slippageBps: null,
    slippageUsd: 0,
    unrealisedPnlUsd: 0,
    realisedPnlUsd: 0,
    marketMid: 1.08,
    limitPrice: 1.082,
    completedAt: null,
    ...overrides,
  };
}

describe('applyFill', () => {
  it('returns absolute post-fill values for a first fill', () => {
    const changes = applyFill(liveOrder(), 100_000, 1.0802, NOW);
    expect(changes).toEqual({
      filledQty: 100_000,
      remainingQty: 900_000,
      pctComplete: 10,
      avgFillPrice: 1.0802,
      lastFillPrice: 1.0802,
      lastFillQty: 100_000,
      numFills: 1,
      numChildOrders: 1,
      filledNotionalUsd: 108_000,
      slippageBps: 1.85,
      slippageUsd: 19.98,
      lastUpdateTime: NOW,
    });
  });

  it('keeps avgFillPrice as the VWAP of all fills', () => {
    let order = liveOrder();
    const fills: [number, number][] = [
      [100_000, 1.08],
      [300_000, 1.0804],
      [100_000, 1.0812],
    ];
    let notional = 0;
    let qty = 0;
    for (const [q, p] of fills) {
      order = { ...order, ...applyFill(order, q, p, NOW) };
      notional += q * p;
      qty += q;
    }
    expect(order.filledQty).toBe(qty);
    expect(order.avgFillPrice).toBeCloseTo(notional / qty, 5);
    expect(order.numFills).toBe(3);
    expect(order.lastFillQty).toBe(100_000);
    expect(order.lastFillPrice).toBe(1.0812);
  });

  it('signs slippage by side so positive is adverse', () => {
    const buy = applyFill(liveOrder({ side: 'BUY' }), 1000, 1.0810, NOW);
    const sell = applyFill(liveOrder({ side: 'SELL' }), 1000, 1.0810, NOW);
    expect(buy.slippageBps).toBeGreaterThan(0);
    expect(sell.slippageBps).toBeLessThan(0);
    expect(slippageBpsOf({ side: 'BUY', arrivalPrice: 1.08 }, 1.0801)).toBeCloseTo(0.93, 2);
  });

  it('clamps to the remaining quantity and completes the order', () => {
    const order = liveOrder({
      filledQty: 950_000,
      remainingQty: 50_000,
      avgFillPrice: 1.0801,
      unrealisedPnlUsd: 12,
      numFills: 9,
      numChildOrders: 12,
      marketMid: 1.081,
    });
    const changes = applyFill(order, 400_000, 1.0805, NOW);
    expect(changes.filledQty).toBe(1_000_000);
    expect(changes.remainingQty).toBe(0);
    expect(changes.lastFillQty).toBe(50_000);
    expect(changes.pctComplete).toBe(100);
    expect(changes.status).toBe('FILLED');
    expect(changes.completedAt).toBe(NOW);
    expect(changes.unrealisedPnlUsd).toBe(0);
    expect(changes.realisedPnlUsd).toBeGreaterThan(0);
    expect(changes.numChildOrders).toBe(13);
  });

  it('does nothing for non-LIVE orders and non-positive quantities', () => {
    expect(applyFill(liveOrder({ status: 'PAUSED' }), 1000, 1.08, NOW)).toEqual({});
    expect(applyFill(liveOrder({ status: 'PENDING_START' }), 1000, 1.08, NOW)).toEqual({});
    expect(applyFill(liveOrder(), 0, 1.08, NOW)).toEqual({});
    expect(applyFill(liveOrder({ remainingQty: 0, filledQty: 1_000_000 }), 10, 1.08, NOW)).toEqual({});
  });

  it('is a pure function of its inputs', () => {
    const order = liveOrder();
    const frozen = structuredClone(order);
    const a = applyFill(order, 50_000, 1.0803, NOW);
    const b = applyFill(order, 50_000, 1.0803, NOW);
    expect(a).toEqual(b);
    expect(order).toEqual(frozen);
  });
});

describe('transition', () => {
  it.each([
    ['PENDING_START', 'LIVE'],
    ['PENDING_START', 'CANCELLED'],
    ['LIVE', 'PAUSED'],
    ['LIVE', 'CANCELLED'],
    ['PAUSED', 'LIVE'],
    ['PAUSED', 'CANCELLED'],
  ] as const)('allows %s to %s', (from, to) => {
    const result = transition(liveOrder({ status: from }), to, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changes).toMatchObject({ status: to, lastUpdateTime: NOW });
  });

  it.each([
    ['PENDING_START', 'PAUSED'],
    ['PENDING_START', 'FILLED'],
    ['LIVE', 'PENDING_START'],
    ['LIVE', 'LIVE'],
    ['PAUSED', 'PAUSED'],
    ['PAUSED', 'FILLED'],
    ['FILLED', 'CANCELLED'],
    ['FILLED', 'LIVE'],
    ['CANCELLED', 'LIVE'],
    ['CANCELLED', 'PAUSED'],
  ] as const)('rejects %s to %s', (from, to) => {
    const result = transition(liveOrder({ status: from }), to, NOW);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('sets completedAt and moves open P&L into realised on a terminal transition', () => {
    const result = transition(liveOrder({ status: 'LIVE', unrealisedPnlUsd: 321.5 }), 'CANCELLED', NOW);
    expect(result).toEqual({
      ok: true,
      changes: { status: 'CANCELLED', lastUpdateTime: NOW, completedAt: NOW, realisedPnlUsd: 321.5, unrealisedPnlUsd: 0 },
    });
  });

  it('only fills an order with nothing remaining', () => {
    expect(transition(liveOrder(), 'FILLED', NOW)).toMatchObject({ ok: false });
    expect(transition(liveOrder({ filledQty: 1_000_000, remainingQty: 0 }), 'FILLED', NOW)).toMatchObject({ ok: true });
  });

  it('does not set completedAt for non-terminal changes', () => {
    const result = transition(liveOrder(), 'PAUSED', NOW);
    expect(result.ok && 'completedAt' in result.changes).toBe(false);
  });
});

describe('derivePriceFields', () => {
  it('derives the market snapshot, spread and distance to limit', () => {
    const changes = derivePriceFields(liveOrder({ side: 'BUY', limitPrice: 1.0822 }), { bid: 1.0799, ask: 1.0801 }, NOW);
    expect(changes).toMatchObject({
      marketBid: 1.0799,
      marketAsk: 1.0801,
      marketMid: 1.08,
      spreadBps: 1.85,
      distanceToLimitBps: 20.37,
      lastUpdateTime: NOW,
    });
  });

  it('flips the distance to limit sign for sells', () => {
    const buy = derivePriceFields(liveOrder({ side: 'BUY', limitPrice: 1.0822 }), { bid: 1.0799, ask: 1.0801 }, NOW);
    const sell = derivePriceFields(liveOrder({ side: 'SELL', limitPrice: 1.0822 }), { bid: 1.0799, ask: 1.0801 }, NOW);
    expect(buy.distanceToLimitBps).toBeGreaterThan(0);
    expect(sell.distanceToLimitBps).toBeLessThan(0);
  });

  it('has a null distance without a limit price and no slippage without fills', () => {
    const changes = derivePriceFields(liveOrder({ limitPrice: null }), { bid: 1.0799, ask: 1.0801 }, NOW);
    expect(changes.distanceToLimitBps).toBeNull();
    expect('slippageBps' in changes).toBe(false);
    expect(changes.unrealisedPnlUsd).toBe(0);
  });

  it('computes slippage and unrealised P&L for orders with fills, signed by side', () => {
    const base = { filledQty: 500_000, remainingQty: 500_000, avgFillPrice: 1.0802 };
    const buy = derivePriceFields(liveOrder({ ...base, side: 'BUY' }), { bid: 1.0809, ask: 1.0811 }, NOW);
    const sell = derivePriceFields(liveOrder({ ...base, side: 'SELL' }), { bid: 1.0809, ask: 1.0811 }, NOW);
    expect(buy.slippageBps).toBeCloseTo(1.85, 2);
    expect(buy.unrealisedPnlUsd).toBeCloseTo(500_000 * 0.0008 * 1, 0);
    expect(sell.unrealisedPnlUsd).toBeCloseTo(-(buy.unrealisedPnlUsd as number), 1);
    expect(sell.slippageBps).toBeCloseTo(-1.85, 2);
  });

  it('only sets unrealised P&L for LIVE and PAUSED orders', () => {
    const base = { filledQty: 500_000, remainingQty: 500_000, avgFillPrice: 1.0802 };
    const quote = { bid: 1.0809, ask: 1.0811 };
    expect(derivePriceFields(liveOrder({ ...base, status: 'PAUSED' }), quote, NOW).unrealisedPnlUsd).not.toBe(0);
    expect('unrealisedPnlUsd' in derivePriceFields(liveOrder({ ...base, status: 'FILLED' }), quote, NOW)).toBe(false);
    expect('unrealisedPnlUsd' in derivePriceFields(liveOrder({ ...base, status: 'PENDING_START' }), quote, NOW)).toBe(false);
  });

  it('rounds to the pair decimals', () => {
    const jpy = liveOrder({ currencyPair: 'USDJPY', arrivalPrice: 150, limitPrice: null });
    const changes = derivePriceFields(jpy, { bid: 150.12349, ask: 150.12551 }, NOW);
    expect(changes.marketBid).toBe(150.123);
    expect(changes.marketAsk).toBe(150.126);
    expect(changes.marketMid).toBe(150.125);
  });

  it('agrees with pnlUsdOf', () => {
    const order = liveOrder({ filledQty: 200_000, remainingQty: 800_000, avgFillPrice: 1.0801 });
    expect(derivePriceFields(order, { bid: 1.0809, ask: 1.0811 }, NOW).unrealisedPnlUsd).toBe(pnlUsdOf(order, 1.081));
  });
});

describe('commands', () => {
  const STATUSES = ['PENDING_START', 'LIVE', 'PAUSED', 'FILLED', 'CANCELLED'] as const;
  const ACTIONS = ['CANCEL', 'PAUSE', 'RESUME'] as const;
  const VALID: Record<(typeof STATUSES)[number], readonly (typeof ACTIONS)[number][]> = {
    PENDING_START: ['CANCEL'],
    LIVE: ['CANCEL', 'PAUSE'],
    PAUSED: ['CANCEL', 'RESUME'],
    FILLED: [],
    CANCELLED: [],
  };

  it('maps each action to its target status', () => {
    expect(COMMAND_TARGET).toEqual({ CANCEL: 'CANCELLED', PAUSE: 'PAUSED', RESUME: 'LIVE' });
  });

  it.each(STATUSES.flatMap((status) => ACTIONS.map((action) => [status, action] as const)))(
    'status %s x action %s matches the Appendix E matrix',
    (status, action) => {
      const valid = VALID[status].includes(action);
      expect(canApplyCommand(status, action)).toBe(valid);
      const result = applyCommand(liveOrder({ status }), action, NOW);
      expect(result.ok).toBe(valid);
      if (result.ok) expect(result.changes).toMatchObject({ status: COMMAND_TARGET[action], lastUpdateTime: NOW });
      else expect(result.code).toBe('INVALID_TRANSITION');
    },
  );

  it('lists the available commands per status', () => {
    for (const status of STATUSES) expect(availableCommands(status)).toEqual(VALID[status]);
  });

  it('explains an invalid command in the message', () => {
    const result = applyCommand(liveOrder({ status: 'FILLED' }), 'CANCEL', NOW);
    expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION', message: 'Cannot cancel an order that is FILLED' });
  });

  it('cancelling closes the order out', () => {
    const result = applyCommand(liveOrder({ status: 'PAUSED', unrealisedPnlUsd: 12 }), 'CANCEL', NOW);
    expect(result).toMatchObject({ ok: true, changes: { status: 'CANCELLED', completedAt: NOW, realisedPnlUsd: 12, unrealisedPnlUsd: 0 } });
  });

  it('exposes canTransition', () => {
    expect(canTransition('LIVE', 'PAUSED')).toBe(true);
    expect(canTransition('FILLED', 'LIVE')).toBe(false);
  });
});
