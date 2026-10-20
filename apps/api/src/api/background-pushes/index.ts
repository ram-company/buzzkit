import { resolveCredential } from '@buzzkit/api/api/messages/send';
import type { Tenant } from '@buzzkit/api/api/tenants/index';
import { BadRequestError } from '@buzzkit/api/libs/error';
import { log } from '@buzzkit/api/libs/logger';
import { trace } from '@buzzkit/api/libs/telemetry';
import { type MessagePayload, PROVIDERS } from '@buzzkit/api/providers/index';
import { createTokenMemo } from '@buzzkit/api/providers/shared/cache';
import { runConcurrently } from '@buzzkit/api/utils/concurrency';
import type { Db } from '@buzzkit/database';
import { BACKGROUND_PUSH_CONCURRENCY } from './constants';
import type { SendBackgroundPushesSchema } from './schemas';
import type { BackgroundPushResult } from './types';

export * from './constants';
export * from './schemas';
export type * from './types';

export function assertBackgroundPushData(data: Record<string, unknown> | undefined): void {
  const reserved = ['aps', 'bk'].find((key) => data !== undefined && key in data);
  if (reserved === undefined) return;
  throw new BadRequestError(`data cannot set \`${reserved}\`; BuzzKit builds it`, {
    code: 'data_key_reserved',
    param: 'data',
  });
}

export function resolveBackgroundPushExpiry(
  ttlSeconds: number | undefined,
  now: number
): Date | null | undefined {
  if (ttlSeconds === undefined) return undefined;
  if (ttlSeconds === 0) return null;
  return new Date(now + ttlSeconds * 1000);
}

export async function sendBackgroundPushes(
  db: Db,
  tenant: Tenant,
  input: typeof SendBackgroundPushesSchema.static
): Promise<BackgroundPushResult[]> {
  assertBackgroundPushData(input.data);
  const environment = input.environment ?? 'production';
  const tokens = input.tokens.map((token) => token.toLowerCase());

  return await trace(
    'backgroundPushes.send',
    { 'tenant.id': tenant.id, 'background_push.environment': environment },
    async (outer) => {
      const credential = await resolveCredential(db, tenant.id, 'apns', environment);
      if (!credential) {
        outer.set('background_push.failed', tokens.length);
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

      const payload: MessagePayload = {
        silent: true,
        ...(input.collapseId !== undefined ? { collapseId: input.collapseId } : {}),
        ...(input.data !== undefined ? { apns: { payload: input.data } } : {}),
      };
      const expiresAt = resolveBackgroundPushExpiry(input.ttlSeconds, Date.now());
      const providerTokens = createTokenMemo();
      const results: BackgroundPushResult[] = [];

      await runConcurrently(
        tokens.map((token, index) => ({ token, index })),
        BACKGROUND_PUSH_CONCURRENCY,
        async ({ token, index }) => {
          const sent = await trace(
            'deliveries.send',
            { 'delivery.provider': 'apns', 'tenant.id': tenant.id },
            async (span) => {
              const result = await PROVIDERS.apns.send({
                credentialId: credential.id,
                credentialUpdatedAt: credential.updatedAt.getTime(),
                secret: credential.secret,
                details: credential.details,
                environment: credential.environment,
                endpoint: token,
                payload,
                expiresAt,
                tokens: providerTokens,
              });
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
          log.warn('[Deliveries] Background push failed', {
            tenantId: tenant.id,
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

      outer.set('background_push.sent', results.filter((entry) => entry.ok).length);
      outer.set('background_push.failed', results.filter((entry) => !entry.ok).length);
      return results;
    }
  );
}
