import { describe, expect, it } from 'vitest';
import { ThemisMetrics } from './metrics.js';

describe('ThemisMetrics', () => {
  it('exposes commit, publish, event, rebuild and open-order figures', async () => {
    const m = new ThemisMetrics();
    m.bind(() => ({ openOrders: 7 }));
    m.commit({ batchSize: 40, seconds: 0.02 });
    m.kvPut(0.005);
    m.event('UPDATE', 'applied');
    m.event('UPDATE', 'applied');
    m.event('NEW', 'unchanged');
    m.projectionRebuilt(12.5);
    const text = await m.render();
    expect(text).toContain('themis_commit_batch_size_sum 40');
    expect(text).toContain('themis_commit_duration_seconds_count 1');
    expect(text).toContain('themis_kv_put_duration_seconds_count 1');
    expect(text).toContain('themis_events_total{type="UPDATE",result="applied"} 2');
    expect(text).toContain('themis_events_total{type="NEW",result="unchanged"} 1');
    expect(text).toContain('themis_projection_rebuild_seconds 12.5');
    expect(text).toContain('themis_open_orders 7');
    expect(m.contentType).toContain('text/plain');
  });

  it('reports no open orders before it is bound', async () => {
    expect(await new ThemisMetrics().render()).toContain('themis_open_orders 0');
  });
});
