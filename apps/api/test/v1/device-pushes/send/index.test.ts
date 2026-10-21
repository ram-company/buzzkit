import { describe, expect, it } from 'vitest';
import { api } from '../../../utils/api';
import { createClientKey, setupWorkspace } from '../../../utils/setup';

type SendBody = {
  results: Array<{ token: string; ok: boolean; status: number | null; apnsId: string | null; code?: string }>;
};

const payload = { aps: { alert: { title: 'Hi', body: 'There' } } };

async function setupTenant() {
  const base = await setupWorkspace();
  const clientKey = await createClientKey(base.owner.token, base.workspace.slug, 'default');
  return {
    ...base,
    clientBearer: { Authorization: `Bearer ${clientKey.secret}` },
    tenantBearer: { ...base.keyBearer, 'buzzkit-tenant': 'default' },
  };
}

describe('/v1/device-pushes/send', () => {
  it('answers one result per token in request order, without a registered subscription', async () => {
    const { tenantBearer } = await setupTenant();
    const tokens = ['AB'.repeat(32), 'cd'.repeat(32)];

    const response = await api<SendBody>('/v1/device-pushes/send', {
      method: 'POST',
      headers: tenantBearer,
      body: JSON.stringify({ tokens, pushType: 'alert', payload }),
    });

    expect(response.status).toBe(200);
    expect(response.body.data?.results.map((result) => result.token)).toEqual([
      'ab'.repeat(32),
      'cd'.repeat(32),
    ]);
    expect(
      response.body.data?.results.every(
        (result) => !result.ok && result.code === 'no_credential' && result.status === null
      )
    ).toBe(true);
  });

  it('refuses a payload without aps', async () => {
    const { tenantBearer } = await setupTenant();
    const response = await api('/v1/device-pushes/send', {
      method: 'POST',
      headers: tenantBearer,
      body: JSON.stringify({ tokens: ['ab'.repeat(32)], pushType: 'background', payload: { type: 'sync' } }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('payload_invalid');
  });

  it('refuses a token that is not hex, an empty token list, an unknown push type and a topic with spaces', async () => {
    const { tenantBearer } = await setupTenant();
    for (const body of [
      { tokens: ['not-a-token'.repeat(4)], pushType: 'alert', payload },
      { tokens: [], pushType: 'alert', payload },
      { tokens: ['ab'.repeat(32)], pushType: 'voip', payload },
      { tokens: ['ab'.repeat(32)], pushType: 'alert', topic: 'com.example app', payload },
    ]) {
      const response = await api('/v1/device-pushes/send', {
        method: 'POST',
        headers: tenantBearer,
        body: JSON.stringify(body),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });

  it('is refused to a client key', async () => {
    const { clientBearer } = await setupTenant();
    const response = await api('/v1/device-pushes/send', {
      method: 'POST',
      headers: clientBearer,
      body: JSON.stringify({ tokens: ['ab'.repeat(32)], pushType: 'alert', payload }),
    });
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });
});
