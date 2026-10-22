import { apnsProvider, sendRequest } from '@buzzkit/api/providers/apns/index';
import { createTokenMemo } from '@buzzkit/api/providers/shared/cache';
import type { ProviderSendInput } from '@buzzkit/api/providers/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateP8 } from '../../utils/providerKeys';

vi.mock('@buzzkit/api/libs/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fetchMock = vi.fn<typeof fetch>();
let p8: string;

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  p8 = await generateP8();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function sendInput(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    credentialId: 1,
    credentialUpdatedAt: 1000,
    secret: p8,
    details: { teamId: 'TEAM123456', keyId: 'KEYID12345', bundleId: 'com.example.app' },
    environment: 'production',
    endpoint: 'a'.repeat(64),
    payload: { title: 'Hey' },
    expiresAt: null,
    tokens: createTokenMemo(),
    ...overrides,
  };
}

function apnsResponse(
  status: number,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('send', () => {
  it('delivers and returns the apns-id', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(200, {}, { 'apns-id': 'ABC-123' }));

    const result = await apnsProvider.send(sendInput());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerMessageId).toBe('ABC-123');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.push.apple.com/3/device/${'a'.repeat(64)}`);
    const headers = new Headers(((init as RequestInit).headers ?? {}) as Record<string, string>);
    expect(headers.get('apns-push-type')).toBe('alert');
    expect(headers.get('apns-priority')).toBe('10');
    expect(headers.get('apns-topic')).toBe('com.example.app');
    expect(headers.get('authorization')).toMatch(/^bearer /);
  });

  it('sends silent and normal-priority pushes at priority 5', async () => {
    fetchMock.mockResolvedValue(apnsResponse(200));

    await apnsProvider.send(sendInput({ payload: { silent: true } }));
    await apnsProvider.send(sendInput({ payload: { title: 'x', priority: 'normal' } }));

    const first = new Headers(
      ((fetchMock.mock.calls[0]![1] as RequestInit).headers ?? {}) as Record<string, string>
    );
    const second = new Headers(
      ((fetchMock.mock.calls[1]![1] as RequestInit).headers ?? {}) as Record<string, string>
    );
    expect(first.get('apns-priority')).toBe('5');
    expect(first.get('apns-push-type')).toBe('background');
    expect(second.get('apns-priority')).toBe('5');
  });

  it('targets the widgets topic for widget reloads', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(200));

    await apnsProvider.send(sendInput({ payload: { widgets: true } }));

    const call = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers((call.headers ?? {}) as Record<string, string>);
    expect(headers.get('apns-topic')).toBe('com.example.app.push-type.widgets');
    expect(headers.get('apns-push-type')).toBe('widgets');
    expect(JSON.parse(call.body as string)).toEqual({ aps: { 'content-changed': true } });
  });

  it('targets the live activity topic for live activity pushes', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(200));

    await apnsProvider.send(sendInput({ payload: { liveActivity: { event: 'update', contentState: {} } } }));

    const headers = new Headers(
      ((fetchMock.mock.calls[0]![1] as RequestInit).headers ?? {}) as Record<string, string>
    );
    expect(headers.get('apns-topic')).toBe('com.example.app.push-type.liveactivity');
    expect(headers.get('apns-push-type')).toBe('liveactivity');
  });

  it('sends a caller-built request with its priority, expiry and body to the credential topic', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(200, {}, { 'apns-id': 'LA-1' }));
    const body = { aps: { event: 'update', 'content-state': { phase: 'live' }, timestamp: 1 } };
    const { payload: _payload, expiresAt: _expiresAt, ...input } = sendInput();

    const result = await sendRequest(input, {
      pushType: 'liveactivity',
      priority: 10,
      expiresAt: new Date('2026-09-02T00:00:00.000Z'),
      body,
    });

    expect(result.ok).toBe(true);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('apns-topic')).toBe('com.example.app.push-type.liveactivity');
    expect(headers.get('apns-push-type')).toBe('liveactivity');
    expect(headers.get('apns-priority')).toBe('10');
    expect(headers.get('apns-expiration')).toBe(String(Date.parse('2026-09-02T00:00:00.000Z') / 1000));
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it('carries the expiry and collapse id headers', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(200));
    const expiresAt = new Date('2026-09-02T00:00:00.000Z');

    await apnsProvider.send(sendInput({ expiresAt, payload: { title: 'x', collapseId: 'thread-9' } }));

    const headers = new Headers(
      ((fetchMock.mock.calls[0]![1] as RequestInit).headers ?? {}) as Record<string, string>
    );
    expect(headers.get('apns-expiration')).toBe(String(Math.floor(expiresAt.getTime() / 1000)));
    expect(headers.get('apns-collapse-id')).toBe('thread-9');
  });

  it('sends a background push with only the caller data, leaving the expiry to APNs', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(200, {}, { 'apns-id': 'BG-1' }));

    await apnsProvider.send(
      sendInput({ expiresAt: undefined, payload: { silent: true, apns: { payload: { type: 'pool_sync' } } } })
    );

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('apns-push-type')).toBe('background');
    expect(headers.get('apns-priority')).toBe('5');
    expect(headers.get('apns-topic')).toBe('com.example.app');
    expect(headers.has('apns-expiration')).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ aps: { 'content-available': 1 }, type: 'pool_sync' });
  });

  it('classifies a dead token and captures the response', async () => {
    fetchMock.mockResolvedValueOnce(apnsResponse(410, { reason: 'Unregistered' }));

    const result = await apnsProvider.send(sendInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_endpoint');
      expect(result.reason).toBe('Unregistered');
      expect(result.response).toEqual({ status: 410, body: { reason: 'Unregistered' } });
    }
  });

  it('carries Retry-After on a rate limit', async () => {
    fetchMock.mockResolvedValueOnce(
      apnsResponse(429, { reason: 'TooManyRequests' }, { 'retry-after': '30' })
    );

    const result = await apnsProvider.send(sendInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('rate_limited');
      expect(result.retryAfterSeconds).toBe(30);
    }
  });

  it('waits 15 minutes after a 5xx unless APNs says otherwise', async () => {
    fetchMock
      .mockResolvedValueOnce(apnsResponse(503, { reason: 'ServiceUnavailable' }))
      .mockResolvedValueOnce(apnsResponse(503, { reason: 'ServiceUnavailable' }, { 'retry-after': '120' }));

    const first = await apnsProvider.send(sendInput());
    const second = await apnsProvider.send(sendInput());

    expect(first).toMatchObject({ ok: false, code: 'provider_unavailable', retryAfterSeconds: 900 });
    expect(second).toMatchObject({ ok: false, code: 'provider_unavailable', retryAfterSeconds: 120 });
  });

  it('keeps the usual retries for a 5xx APNs did not answer itself or a push that expires sooner', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(apnsResponse(503, { reason: 'ServiceUnavailable' }));

    const gateway = await apnsProvider.send(sendInput());
    const shortLived = await apnsProvider.send(sendInput({ expiresAt: new Date(Date.now() + 5 * 60_000) }));

    expect(gateway).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(shortLived).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(gateway.ok ? undefined : gateway.retryAfterSeconds).toBeUndefined();
    expect(shortLived.ok ? undefined : shortLived.retryAfterSeconds).toBeUndefined();
  });

  it('mints the JWT once per credential and reuses it within the memo', async () => {
    fetchMock.mockResolvedValue(apnsResponse(200));
    const tokens = createTokenMemo();

    await apnsProvider.send(sendInput({ tokens }));
    await apnsProvider.send(sendInput({ tokens }));

    const first = new Headers(
      ((fetchMock.mock.calls[0]![1] as RequestInit).headers ?? {}) as Record<string, string>
    ).get('authorization');
    const second = new Headers(
      ((fetchMock.mock.calls[1]![1] as RequestInit).headers ?? {}) as Record<string, string>
    ).get('authorization');
    expect(first).toBe(second);
  });

  it('evicts an expired provider token and retries once with a fresh one', async () => {
    fetchMock
      .mockResolvedValueOnce(apnsResponse(403, { reason: 'ExpiredProviderToken' }))
      .mockResolvedValueOnce(apnsResponse(200, {}, { 'apns-id': 'RETRIED' }));

    const result = await apnsProvider.send(sendInput());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerMessageId).toBe('RETRIED');
  });

  it('gives up after a second expired-token rejection', async () => {
    fetchMock.mockResolvedValue(apnsResponse(403, { reason: 'ExpiredProviderToken' }));

    const result = await apnsProvider.send(sendInput());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_credential');
  });

  it('reports an unusable key as invalid_credential without calling APNs', async () => {
    const result = await apnsProvider.send(sendInput({ secret: 'not-a-key' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_credential');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies a transport failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'));

    const result = await apnsProvider.send(sendInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('transport');
      expect(result.response).toBeNull();
    }
  });
});
