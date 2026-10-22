import type { ProviderEnvironment } from '../types';

export type ApnsPushType = 'alert' | 'background' | 'liveactivity' | 'widgets';

const TOPIC_SUFFIXES: Partial<Record<ApnsPushType, string>> = {
  liveactivity: '.push-type.liveactivity',
  widgets: '.push-type.widgets',
};

export const HOSTS: Record<ProviderEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export function apnsTopic(bundleId: string, pushType?: ApnsPushType): string {
  return `${bundleId}${(pushType && TOPIC_SUFFIXES[pushType]) ?? ''}`;
}

export function buildHeaders(params: {
  jwt: string;
  bundleId: string;
  priority: number;
  pushType?: ApnsPushType;
  collapseId?: string;
  expiresAt?: Date | null;
}): Record<string, string> {
  return {
    authorization: `bearer ${params.jwt}`,
    'apns-topic': apnsTopic(params.bundleId, params.pushType),
    'apns-push-type': params.pushType ?? 'alert',
    'apns-priority': String(params.priority),
    ...(params.expiresAt === undefined
      ? {}
      : { 'apns-expiration': String(params.expiresAt ? Math.floor(params.expiresAt.getTime() / 1000) : 0) }),
    'content-type': 'application/json',
    ...(params.collapseId ? { 'apns-collapse-id': params.collapseId } : {}),
  };
}
