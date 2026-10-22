import {
  assertDevicePushPayload,
  resolveDevicePushExpiry,
  sendDevicePushes,
} from '@buzzkit/api/api/device-pushes/index';
import type { Tenant } from '@buzzkit/api/api/tenants/index';
import type { Db } from '@buzzkit/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();
const resolveCredential = vi.fn();

vi.mock('@buzzkit/api/libs/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@buzzkit/api/providers/apns/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@buzzkit/api/providers/apns/index')>()),
  sendRequest: (...args: unknown[]) => sendRequest(...args),
}));
vi.mock('@buzzkit/api/api/messages/send', () => ({
  resolveCredential: (...args: unknown[]) => resolveCredential(...args),
}));

const db = {} as Db;
const tenant = { id: 1 } as Tenant;

const credential = {
  id: 3,
  updatedAt: new Date(1000),
  secret: 'p8',
  details: { teamId: 'T', keyId: 'K', bundleId: 'com.example.app' },
  environment: 'sandbox',
};

const live = 'A'.repeat(64);
const dead = 'b'.repeat(64);
const unreachable = 'c'.repeat(64);
const alert = { aps: { alert: { title: 'Hi', body: 'There' } }, type: 'pool_ready' };

beforeEach(() => {
  sendRequest.mockReset();
  resolveCredential.mockReset();
});

describe('sendDevicePushes', () => {
  it('sends the caller payload to each token and reports its APNs outcome in request order', async () => {
    resolveCredential.mockResolvedValue(credential);
    sendRequest.mockImplementation(async (input: { endpoint: string }) => {
      if (input.endpoint === dead) {
        return {
          ok: false,
          code: 'invalid_endpoint',
          reason: 'Unregistered',
          request: {},
          response: { status: 410, body: { reason: 'Unregistered' } },
          latencyMs: 4,
        };
      }
      if (input.endpoint === unreachable) {
        return {
          ok: false,
          code: 'transport',
          reason: 'connection reset',
          request: {},
          response: null,
          latencyMs: 4,
        };
      }
      return {
        ok: true,
        providerMessageId: 'apns-1',
        request: {},
        response: { status: 200, body: null },
        latencyMs: 4,
      };
    });

    const results = await sendDevicePushes(db, tenant, {
      tokens: [live, dead, unreachable],
      pushType: 'alert',
      environment: 'sandbox',
      collapseId: 'note-1',
      expiration: 2_000_000_000,
      payload: alert,
    });

    expect(results).toEqual([
      { token: live.toLowerCase(), ok: true, status: 200, apnsId: 'apns-1' },
      { token: dead, ok: false, status: 410, apnsId: null, code: 'invalid_endpoint', reason: 'Unregistered' },
      {
        token: unreachable,
        ok: false,
        status: null,
        apnsId: null,
        code: 'transport',
        reason: 'connection reset',
      },
    ]);
    expect(resolveCredential).toHaveBeenCalledWith(db, 1, 'apns', 'sandbox');
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: live.toLowerCase(), environment: 'sandbox' }),
      {
        pushType: 'alert',
        priority: 10,
        collapseId: 'note-1',
        expiresAt: new Date(2_000_000_000_000),
        body: alert,
      }
    );
    const memos = new Set(sendRequest.mock.calls.map(([input]) => (input as { tokens: unknown }).tokens));
    expect(memos.size).toBe(1);
    expect([...memos][0]).toBeDefined();
  });

  it("sends background pushes at priority 5 and accepts the credential's own topic", async () => {
    resolveCredential.mockResolvedValue(credential);
    sendRequest.mockResolvedValue({
      ok: true,
      providerMessageId: null,
      request: {},
      response: { status: 200, body: null },
      latencyMs: 1,
    });
    const background = { aps: { 'content-available': 1 }, type: 'sync' };

    await sendDevicePushes(db, tenant, { tokens: [live], pushType: 'background', payload: background });
    await sendDevicePushes(db, tenant, {
      tokens: [live],
      pushType: 'liveactivity',
      topic: 'com.example.app.push-type.liveactivity',
      priority: 5,
      payload: { aps: { event: 'update', 'content-state': {} } },
    });

    expect(sendRequest.mock.calls[0]![1]).toEqual({
      pushType: 'background',
      priority: 5,
      expiresAt: undefined,
      body: background,
    });
    expect(sendRequest.mock.calls[1]![1]).toEqual({
      pushType: 'liveactivity',
      priority: 5,
      expiresAt: undefined,
      body: { aps: { event: 'update', 'content-state': {} } },
    });
    expect(resolveCredential).toHaveBeenCalledWith(db, 1, 'apns', 'production');
  });

  it("refuses a topic other than the credential's app and a background push at priority 10", async () => {
    resolveCredential.mockResolvedValue(credential);

    await expect(
      sendDevicePushes(db, tenant, {
        tokens: [live],
        pushType: 'alert',
        topic: 'com.example.app.debug',
        payload: alert,
      })
    ).rejects.toMatchObject({ code: 'topic_not_allowed' });
    await expect(
      sendDevicePushes(db, tenant, {
        tokens: [live],
        pushType: 'liveactivity',
        topic: 'com.example.app',
        payload: { aps: { event: 'update', 'content-state': {} } },
      })
    ).rejects.toMatchObject({ code: 'topic_not_allowed' });
    await expect(
      sendDevicePushes(db, tenant, {
        tokens: [live],
        pushType: 'background',
        priority: 10,
        payload: { aps: { 'content-available': 1 } },
      })
    ).rejects.toMatchObject({ code: 'priority_not_allowed' });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('reports every token as no_credential without sending when the environment has no credential', async () => {
    resolveCredential.mockResolvedValue(null);

    const results = await sendDevicePushes(db, tenant, {
      tokens: [live, dead],
      pushType: 'alert',
      payload: alert,
    });

    expect(results.map((result) => [result.ok, result.code])).toEqual([
      [false, 'no_credential'],
      [false, 'no_credential'],
    ]);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

describe('assertDevicePushPayload', () => {
  it('needs an aps object and refuses a payload over the APNs limit', () => {
    expect(() => assertDevicePushPayload(alert)).not.toThrow();
    expect(() => assertDevicePushPayload({ type: 'sync' })).toThrow(
      expect.objectContaining({ code: 'payload_invalid' })
    );
    expect(() => assertDevicePushPayload({ aps: [] })).toThrow(
      expect.objectContaining({ code: 'payload_invalid' })
    );
    expect(() => assertDevicePushPayload({ aps: {}, padding: 'x'.repeat(4096) })).toThrow(
      expect.objectContaining({ code: 'payload_too_large' })
    );
  });
});

describe('resolveDevicePushExpiry', () => {
  it('leaves storage to APNs without an expiration, tries once at zero, and stores until the given second otherwise', () => {
    expect(resolveDevicePushExpiry(undefined)).toBeUndefined();
    expect(resolveDevicePushExpiry(0)).toBeNull();
    expect(resolveDevicePushExpiry(61)).toEqual(new Date(61_000));
  });
});
