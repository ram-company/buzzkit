import { describeError } from '@buzzkit/api/libs/error';
import { cachedToken, evictToken } from '../shared/cache';
import { providerFetch, retryAfterSeconds } from '../shared/http';
import type { ProviderSendInput, ProviderSendResult } from '../types';
import { classify } from './classify';
import { buildApnsPayload, isSilentPayload, resolvePushType } from './payload';
import { type ApnsPushType, buildHeaders, HOSTS } from './request';
import { createApnsJwt, JWT_TTL_SECONDS, jwtCacheKey } from './tokens';

const SERVER_ERROR_RETRY_SECONDS = 15 * 60;

export type ApnsRequest = {
  pushType: ApnsPushType;
  priority: 5 | 10;
  collapseId?: string;
  expiresAt?: Date | null;
  body: Record<string, unknown>;
};

export type ApnsRequestInput = Omit<ProviderSendInput, 'payload' | 'expiresAt'>;

export async function send(input: ProviderSendInput): Promise<ProviderSendResult> {
  return await sendRequest(input, {
    pushType: resolvePushType(input.payload),
    priority: isSilentPayload(input.payload) || input.payload.priority === 'normal' ? 5 : 10,
    collapseId: input.payload.collapseId,
    expiresAt: input.expiresAt,
    body: buildApnsPayload(input.payload),
  });
}

export async function sendRequest(
  input: ApnsRequestInput,
  request: ApnsRequest
): Promise<ProviderSendResult> {
  const first = await attempt(input, request);
  if (first.ok || first.code !== 'invalid_credential' || first.reason !== 'ExpiredProviderToken')
    return first;
  return attempt(input, request);
}

async function attempt(input: ApnsRequestInput, request: ApnsRequest): Promise<ProviderSendResult> {
  const startedAt = Date.now();
  const cacheKey = await jwtCacheKey(input);

  let jwt: string;
  try {
    jwt = await cachedToken(
      cacheKey,
      JWT_TTL_SECONDS,
      () => {
        return createApnsJwt({
          p8: input.secret,
          teamId: input.details.teamId ?? '',
          keyId: input.details.keyId ?? '',
        });
      },
      input.tokens
    );
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_credential',
      reason: describeError(error),
      request: request.body,
      response: null,
      latencyMs: Date.now() - startedAt,
    };
  }

  const result = await providerFetch(`${HOSTS[input.environment]}/3/device/${input.endpoint}`, {
    method: 'POST',
    headers: buildHeaders({
      jwt,
      bundleId: input.details.bundleId ?? '',
      priority: request.priority,
      pushType: request.pushType,
      collapseId: request.collapseId,
      expiresAt: request.expiresAt,
    }),
    body: JSON.stringify(request.body),
  });

  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      reason: result.reason,
      request: request.body,
      response: null,
      latencyMs: result.latencyMs,
    };
  }

  if (result.response.ok) {
    return {
      ok: true,
      providerMessageId: result.response.headers.get('apns-id'),
      request: request.body,
      response: result.captured,
      latencyMs: result.latencyMs,
    };
  }

  const reason = (result.captured.body as { reason?: string } | null)?.reason ?? null;
  if (reason === 'ExpiredProviderToken') {
    await evictToken(cacheKey, input.tokens);
  }

  return {
    ok: false,
    code: classify(result.response.status, reason),
    reason: reason ?? `apns_status_${result.response.status}`,
    retryAfterSeconds:
      retryAfterSeconds(result.response) ??
      (result.response.status >= 500 ? SERVER_ERROR_RETRY_SECONDS : undefined),
    request: request.body,
    response: result.captured,
    latencyMs: result.latencyMs,
  };
}
