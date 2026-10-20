import { MAX_TTL_SECONDS } from '@buzzkit/api/api/messages/constants';
import { t } from 'elysia';
import { MAX_BACKGROUND_PUSH_TOKENS } from './constants';

export const BackgroundPushTokenSchema = t.String({
  minLength: 32,
  maxLength: 512,
  pattern: '^[0-9a-fA-F]+$',
});

export const SendBackgroundPushesSchema = t.Object({
  tokens: t.Array(BackgroundPushTokenSchema, { minItems: 1, maxItems: MAX_BACKGROUND_PUSH_TOKENS }),
  environment: t.Optional(t.Union([t.Literal('production'), t.Literal('sandbox')])),
  data: t.Optional(t.Record(t.String(), t.Any())),
  collapseId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  ttlSeconds: t.Optional(t.Integer({ minimum: 0, maximum: MAX_TTL_SECONDS })),
});
