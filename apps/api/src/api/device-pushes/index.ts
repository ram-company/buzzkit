import { resolveCredential } from '@buzzkit/api/api/messages/send';
import type { Tenant } from '@buzzkit/api/api/tenants/index';
import { BadRequestError } from '@buzzkit/api/libs/error';
import { log } from '@buzzkit/api/libs/logger';
import { trace } from '@buzzkit/api/libs/telemetry';
import { type ApnsRequest, apnsTopic, sendRequest } from '@buzzkit/api/providers/apns/index';
import { createTokenMemo } from '@buzzkit/api/providers/shared/cache';
import { runConcurrently } from '@buzzkit/api/utils/concurrency';
import type { Db } from '@buzzkit/database';
import { DEVICE_PUSH_CONCURRENCY, MAX_DEVICE_PUSH_PAYLOAD_BYTES } from './constants';
import type { SendDevicePushesSchema } from './schemas';
import type { DevicePushResult } from './types';

export * from './constants';
export * from './schemas';
export type * from './types';

export function assertDevicePushPayload(payload: Record<string, unknown>): void {
  const aps = payload.aps;
  if (typeof aps !== 'object' || aps === null || Array.isArray(aps)) {
    throw new BadRequestError('payload needs an `aps` object', {
      code: 'payload_invalid',
      param: 'payload.aps',
    });
  }

  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes <= MAX_DEVICE_PUSH_PAYLOAD_BYTES) return;
  throw new BadRequestError(
    `payload is ${bytes} bytes; APNs takes at most ${MAX_DEVICE_PUSH_PAYLOAD_BYTES}`,
    { code: 'payload_too_large', param: 'payload' }
  );
}

export function assertDevicePushPriority(input: typeof SendDevicePushesSchema.static): void {
  if (input.pushType !== 'background' || input.priority !== 10) return;
  throw new BadRequestError('a background push takes priority 5; APNs refuses 10', {
    code: 'priority_not_allowed',
    param: 'priority',
  });
}

export function assertDevicePushTopic(topic: string | undefined, allowed: string): void {
  if (topic === undefined || topic === allowed) return;
  throw new BadRequestError(`topic must be ${allowed}, the app of this tenant's credential`, {
    code: 'topic_not_allowed',
    param: 'topic',
  });
}

export function resolveDevicePushExpiry(expiration: number | undefined): Date | null | undefined {
  if (expiration === undefined) return undefined;
  if (expiration === 0) return null;
  return new Date(expiration * 1000);
}

export async function sendDevicePushes(
  db: Db,
  tenant: Tenant,
  input: typeof SendDevicePushesSchema.static
): Promise<DevicePushResult[]> {
  assertDevicePushPayload(input.payload);
  assertDevicePushPriority(input);
  const environment = input.environment ?? 'production';
  const tokens = input.tokens.map((token) => token.toLowerCase());

  return await trace(
    'devicePushes.send',
    {
      'tenant.id': tenant.id,
      'device_push.environment': environment,
      'device_push.push_type': input.pushType,
    },
    async (outer) => {
      const credential = await resolveCredential(db, tenant.id, 'apns', environment);
      if (!credential) {
        outer.set('device_push.failed', tokens.length);
        return tokens.map((token) => {
          return {
            token,
            ok: false,
            status: null,
            apnsId: null,
            code: 'no_credential',
            reason: `No ${environment} APNs credential configured`,
          };
        });
      }

      assertDevicePushTopic(input.topic, apnsTopic(credential.details.bundleId ?? '', input.pushType));

      const request: ApnsRequest = {
        pushType: input.pushType,
        priority: input.priority ?? (input.pushType === 'background' ? 5 : 10),
        ...(input.collapseId !== undefined ? { collapseId: input.collapseId } : {}),
        expiresAt: resolveDevicePushExpiry(input.expiration),
        body: input.payload,
      };
      const providerTokens = createTokenMemo();
      const results: DevicePushResult[] = [];

      await runConcurrently(
        tokens.map((token, index) => ({ token, index })),
        DEVICE_PUSH_CONCURRENCY,
        async ({ token, index }) => {
          const sent = await trace(
            'deliveries.send',
            { 'delivery.provider': 'apns', 'tenant.id': tenant.id },
            async (span) => {
              const result = await sendRequest(
                {
                  credentialId: credential.id,
                  credentialUpdatedAt: credential.updatedAt.getTime(),
                  secret: credential.secret,
                  details: credential.details,
                  environment: credential.environment,
                  endpoint: token,
                  tokens: providerTokens,
                },
                request
              );
              span.set('delivery.ok', result.ok);
              if (!result.ok) span.set('delivery.code', result.code);
              return result;
            }
          );
          const status = sent.response?.status ?? null;
          if (sent.ok) {
            results[index] = { token, ok: true, status, apnsId: sent.providerMessageId };
            return;
          }
          log.warn('[Deliveries] Device push failed', {
            tenantId: tenant.id,
            pushType: input.pushType,
            code: sent.code,
            reason: sent.reason,
          });
          results[index] = {
            token,
            ok: false,
            status,
            apnsId: null,
            code: sent.code,
            reason: sent.reason,
            ...(sent.retryAfterSeconds !== undefined ? { retryAfterSeconds: sent.retryAfterSeconds } : {}),
          };
        }
      );

      outer.set('device_push.sent', results.filter((entry) => entry.ok).length);
      outer.set('device_push.failed', results.filter((entry) => !entry.ok).length);
      return results;
    }
  );
}
