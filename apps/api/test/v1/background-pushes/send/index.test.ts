import { describe, expect, it } from 'vitest';
import { api } from '../../../utils/api';
import { createClientKey, setupWorkspace } from '../../../utils/setup';

type SendBody = {
  results: Array<{ token: string; ok: boolean; status: number | null; apnsId: string | null; code?: string }>;
};

async function setupTenant() {
  const base = await setupWorkspace();
  const clientKey = await createClientKey(base.owner.token, base.workspace.slug, 'default');
  return {
    ...base,
    clientBearer: { Authorization: `Bearer ${clientKey.secret}` },
    tenantBearer: { ...base.keyBearer, 'buzzkit-tenant': 'default' },
  };
}

describe('/v1/background-pushes/send', () => {
  it('answers one result per token in request order, without a registered subscription', async () => {
    const { tenantBearer } = await setupTenant();
    const tokens = ['AB'.repeat(32), 'cd'.repeat(32)];

    const response = await api<SendBody>('/v1/background-pushes/send', {
      method: 'POST',
      headers: tenantBearer,
      body: JSON.stringify({ tokens, data: { type: 'pool_sync' } }),
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

  it('refuses data that sets aps', async () => {
    const { tenantBearer } = await setupTenant();
    const response = await api('/v1/background-pushes/send', {
      method: 'POST',
      headers: tenantBearer,
      body: JSON.stringify({ tokens: ['ab'.repeat(32)], data: { aps: { alert: 'hi' } } }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('data_key_reserved');
  });

  it('refuses a token that is not hex and an empty token list', async () => {
    const { tenantBearer } = await setupTenant();
    for (const tokens of [['not-a-token'.repeat(4)], []]) {
      const response = await api('/v1/background-pushes/send', {
        method: 'POST',
        headers: tenantBearer,
        body: JSON.stringify({ tokens }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });

  it('is refused to a client key', async () => {
    const { clientBearer } = await setupTenant();
    const response = await api('/v1/background-pushes/send', {
      method: 'POST',
      headers: clientBearer,
      body: JSON.stringify({ tokens: ['ab'.repeat(32)] }),
    });
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  });
});
