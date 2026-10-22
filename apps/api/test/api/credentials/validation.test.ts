import {
  detectCredentialEnvironments,
  validateCredentialUpload,
} from '@buzzkit/api/api/credentials/validation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const validate = vi.fn();

vi.mock('@buzzkit/api/providers/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('@buzzkit/api/providers/index')>();
  return {
    ...original,
    PROVIDERS: {
      ...original.PROVIDERS,
      apns: { ...original.PROVIDERS.apns, validate: (...args: unknown[]) => validate(...args) },
    },
  };
});

const input = {
  secret: 'p8',
  details: { teamId: 'TEAM123456', keyId: 'KEYID12345', bundleId: 'com.example.app' },
};

beforeEach(() => {
  validate.mockReset();
});

describe('validateCredentialUpload', () => {
  it('stores a key APNs answered without judging, a rate limit included, as unvalidated', async () => {
    validate.mockResolvedValue({ ok: false, code: 'rate_limited', reason: 'TooManyProviderTokenUpdates' });

    await expect(validateCredentialUpload('apns', { ...input, environment: 'production' })).resolves.toEqual({
      status: 'unvalidated',
      lastError: 'APNs unreachable: TooManyProviderTokenUpdates',
    });
  });
});

describe('detectCredentialEnvironments', () => {
  it("names the real failure, not the other slot's wrong-environment answer, when both slots refuse", async () => {
    validate.mockImplementation(async ({ environment }: { environment: string }) =>
      environment === 'production'
        ? { ok: false, code: 'invalid_credential', reason: 'BadEnvironmentKeyIdInToken' }
        : { ok: false, code: 'invalid_credential', reason: 'InvalidProviderToken' }
    );

    await expect(detectCredentialEnvironments('apns', input)).rejects.toMatchObject({
      code: 'credential_rejected',
      message: 'APNs rejected the credential: InvalidProviderToken',
    });
  });
});
