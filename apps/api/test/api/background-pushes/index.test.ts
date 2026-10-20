import {
  assertBackgroundPushData,
  resolveBackgroundPushExpiry,
  sendBackgroundPushes,
} from '@buzzkit/api/api/background-pushes/index';
import type { Tenant } from '@buzzkit/api/api/tenants/index';
import type { Db } from '@buzzkit/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const resolveCredential = vi.fn();

vi.mock('@buzzkit/api/libs/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@buzzkit/api/providers/index', () => ({
  PROVIDERS: { apns: { send: (input: unknown) => send(input) } },
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

beforeEach(() => {
  send.mockReset();
  resolveCredential.mockReset();
});

describe('sendBackgroundPushes', () => {
  it('sends each token as a background push and reports its APNs outcome in request order', async () => {
    resolveCredential.mockResolvedValue(credential);
    send.mockImplementation(async (input: { endpoint: string }) => {
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

    const results = await sendBackgroundPushes(db, tenant, {
      tokens: [live, dead, unreachable],
      environment: 'sandbox',
      data: { type: 'pool_sync' },
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
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: live.toLowerCase(),
        environment: 'sandbox',
        payload: { silent: true, apns: { payload: { type: 'pool_sync' } } },
        expiresAt: undefined,
      })
    );
    const memos = new Set(send.mock.calls.map(([input]) => (input as { tokens: unknown }).tokens));
    expect(memos.size).toBe(1);
    expect([...memos][0]).toBeDefined();
  });

  it('reports every token as no_credential without sending when the environment has no credential', async () => {
    resolveCredential.mockResolvedValue(null);

    const results = await sendBackgroundPushes(db, tenant, { tokens: [live, dead] });

    expect(results.map((result) => [result.ok, result.code])).toEqual([
      [false, 'no_credential'],
      [false, 'no_credential'],
    ]);
    expect(resolveCredential).toHaveBeenCalledWith(db, 1, 'apns', 'production');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses data that would replace the aps dictionary', async () => {
    await expect(
      sendBackgroundPushes(db, tenant, { tokens: [live], data: { aps: { alert: 'hi' } } })
    ).rejects.toMatchObject({ code: 'data_key_reserved' });
    expect(() => assertBackgroundPushData({ bk: {} })).toThrow();
    expect(() => assertBackgroundPushData({ type: 'pool_sync' })).not.toThrow();
  });
});

describe('resolveBackgroundPushExpiry', () => {
  it('leaves storage to APNs without a ttl, tries once at zero, and stores until the ttl otherwise', () => {
    expect(resolveBackgroundPushExpiry(undefined, 1_000)).toBeUndefined();
    expect(resolveBackgroundPushExpiry(0, 1_000)).toBeNull();
    expect(resolveBackgroundPushExpiry(60, 1_000)).toEqual(new Date(61_000));
  });
});
