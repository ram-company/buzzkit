import { t } from 'elysia';
import { MAX_DEVICE_PUSH_TOKENS } from './constants';

export const DevicePushTokenSchema = t.String({
  minLength: 32,
  maxLength: 512,
  pattern: '^[0-9a-fA-F]+$',
});

export const SendDevicePushesSchema = t.Object({
  tokens: t.Array(DevicePushTokenSchema, { minItems: 1, maxItems: MAX_DEVICE_PUSH_TOKENS }),
  pushType: t.Union([t.Literal('alert'), t.Literal('background'), t.Literal('liveactivity')]),
  environment: t.Optional(t.Union([t.Literal('production'), t.Literal('sandbox')])),
  topic: t.Optional(t.String({ minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9.-]+$' })),
  priority: t.Optional(t.Union([t.Literal(5), t.Literal(10)])),
  collapseId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  expiration: t.Optional(t.Integer({ minimum: 0 })),
  payload: t.Record(t.String(), t.Any()),
});
