import { describe, expect, it } from 'vitest';
import { HeliosMetrics } from './metrics.js';

describe('HeliosMetrics', () => {
  it('counts ticks and publish errors', async () => {
    const m = new HeliosMetrics();
    m.tick();
    m.tick();
    m.publishError();
    const text = await m.render();
    expect(text).toContain('helios_ticks_total 2');
    expect(text).toContain('helios_publish_errors_total 1');
    expect(m.contentType).toContain('text/plain');
  });
});
