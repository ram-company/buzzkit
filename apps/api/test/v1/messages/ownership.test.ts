import { and } from '@buzzkit/database';
import { describe, expect, it } from 'vitest';
import { api, BASE_URL } from '../../utils/api';
import { db, eq, tables } from '../../utils/db';
import { eventually } from '../../utils/eventually';
import { setupWorkspace, uniq } from '../../utils/setup';
import { subscribe } from '../../utils/workflows';

type DeliveryRow = { id: string; status: string; lastErrorCode: string | null; nextAttemptAt: string | null };

async function setPolicy(headers: Record<string, string>, sendPolicy: unknown) {
  await api('/v1/tenants/default', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ settings: { sendPolicy } }),
  });
}

async function subscriberIdFor(tenantId: number, externalId: string): Promise<number> {
  const [row] = await db
    .select({ id: tables.subscriber.id })
    .from(tables.subscriber)
    .where(and(eq(tables.subscriber.tenantId, tenantId), eq(tables.subscriber.externalId, externalId)));
  return row!.id;
}

describe('delivery ownership', () => {
  it('fails a queued delivery whose device moved to another subscriber before it went out', async () => {
    const { keyBearer, tenantId } = await setupWorkspace();
    const headers = { ...keyBearer, 'buzzkit-tenant': 'default' };
    await setPolicy(headers, { quietHours: { from: '00:00', to: '23:59', timezone: 'UTC' } });
    const former = `user_${uniq()}`;
    const current = `user_${uniq()}`;
    await subscribe(headers, former);
    await subscribe(headers, current);

    const sent = await api<{ id: string }>('/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: former, title: 'For the former account only' }),
    });
    expect(sent.status).toBe(202);
    await eventually(
      async () => {
        const { body } = await api<{ items: DeliveryRow[] }>(`/v1/subscribers/${former}/deliveries`, {
          headers,
        });
        return body.data?.items.find((item) => item.status === 'pending' && item.nextAttemptAt !== null);
      },
      { label: 'deferred delivery' }
    );

    const formerId = await subscriberIdFor(tenantId, former);
    const currentId = await subscriberIdFor(tenantId, current);
    await db
      .update(tables.subscription)
      .set({ subscriberId: currentId })
      .where(eq(tables.subscription.subscriberId, formerId));
    await setPolicy(headers, { quietHours: null });
    await db
      .update(tables.delivery)
      .set({ status: 'retrying', nextAttemptAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(tables.delivery.subscriberId, formerId));
    const tick = await fetch(`${BASE_URL}/__scheduled?cron=*/5+*+*+*+*`);
    expect(tick.ok).toBe(true);

    const settled = await eventually(
      async () => {
        const { body } = await api<{ items: DeliveryRow[] }>(`/v1/subscribers/${former}/deliveries`, {
          headers,
        });
        return body.data?.items.find((item) => item.status === 'failed');
      },
      { label: 'moved delivery failed' }
    );
    expect(settled.lastErrorCode).toBe('unsubscribed');
  });
});
