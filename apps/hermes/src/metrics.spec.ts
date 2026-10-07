import { describe, expect, it } from 'vitest';
import { HermesMetrics } from './metrics.js';

const sample = (text: string, series: string): number | undefined => {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

describe('HermesMetrics', () => {
  it('counts events by type, ticks, commands and publish errors', async () => {
    const m = new HermesMetrics();
    m.event('NEW');
    m.event('UPDATE');
    m.event('UPDATE');
    m.tick();
    m.commandHandled();
    m.publishError();
    const text = await m.render();
    expect(sample(text, 'hermes_events_published_total{type="UPDATE"}')).toBe(2);
    expect(sample(text, 'hermes_events_published_total{type="NEW"}')).toBe(1);
    expect(sample(text, 'hermes_price_ticks_total')).toBe(1);
    expect(sample(text, 'hermes_commands_handled_total')).toBe(1);
    expect(sample(text, 'hermes_publish_errors_total')).toBe(1);
    expect(text).toContain('process_cpu_seconds_total');
  });

  it('reads LIVE count and the active preset (one-hot) when scraped, and follows a change', async () => {
    const m = new HermesMetrics();
    expect(sample(await m.render(), 'hermes_live_orders')).toBe(0);
    let preset: 'medium' | 'stress' = 'medium';
    m.bind(() => ({ preset, live: 480, pending: 12, inflight: 3 }));
    let text = await m.render();
    expect(sample(text, 'hermes_live_orders')).toBe(480);
    expect(sample(text, 'hermes_pending_orders')).toBe(12);
    expect(sample(text, 'hermes_publish_inflight')).toBe(3);
    expect(sample(text, 'hermes_preset{preset="medium"}')).toBe(1);
    expect(sample(text, 'hermes_preset{preset="stress"}')).toBe(0);
    preset = 'stress';
    text = await m.render();
    expect(sample(text, 'hermes_preset{preset="medium"}')).toBe(0);
    expect(sample(text, 'hermes_preset{preset="stress"}')).toBe(1);
  });
});
