import { resolveQueueRole } from '@buzzkit/api/queue/index';
import { describe, expect, it } from 'vitest';

describe('resolveQueueRole', () => {
  it('reads the role from a queue name with or without a deployment prefix', () => {
    expect(resolveQueueRole('buzzkit-deliveries')).toBe('buzzkit-deliveries');
    expect(resolveQueueRole('pool-buzzkit-deliveries')).toBe('buzzkit-deliveries');
    expect(resolveQueueRole('pool-buzzkit-deliveries-dlq')).toBe('buzzkit-deliveries-dlq');
    expect(resolveQueueRole('pool-buzzkit-events')).toBe('buzzkit-events');
    expect(resolveQueueRole('pool-buzzkit-events-dlq')).toBe('buzzkit-events-dlq');
    expect(resolveQueueRole('pool-buzzkit-webhooks')).toBe('buzzkit-webhooks');
    expect(resolveQueueRole('mybuzzkit-deliveries')).toBeNull();
    expect(resolveQueueRole('pool-other')).toBeNull();
  });
});
