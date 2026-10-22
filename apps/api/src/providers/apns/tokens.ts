import { sha256Hex } from '@buzzkit/api/libs/crypto';
import { signJwt } from '../shared/jwt';

export const JWT_TTL_SECONDS = 50 * 60;

export async function jwtCacheKey(input: {
  secret: string;
  details: Record<string, string>;
}): Promise<string> {
  return `apns:jwt:${await sha256Hex(`${input.details.teamId ?? ''}:${input.details.keyId ?? ''}:${input.secret}`)}`;
}

export function createApnsJwt(params: { p8: string; teamId: string; keyId: string }): Promise<string> {
  return signJwt({
    algorithm: 'ES256',
    privateKeyPem: params.p8,
    header: { kid: params.keyId },
    claims: { iss: params.teamId, iat: Math.floor(Date.now() / 1000) },
  });
}
