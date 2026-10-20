// One-time setup of Pool's BuzzKit workspace through the deployed API, as the dashboard owner:
//   pool/run bun pool/setup-workspace.ts
// Creates the owner account (before the sign-up WAF rule), the `pool` workspace, a `staging`
// tenant beside `default`, enforces identity verification, uploads the APNs key per tenant and
// environment, and mints one server key and one client key per tenant. Keys and identity
// secrets go to pool/.env.keys (git-ignored, mode 600); nothing secret is printed.
import { appendFileSync } from 'node:fs';

const API = 'https://push-api.pool.day';
const ORIGIN = 'https://push.pool.day';
const WORKSPACE = 'pool';
const KEYS_FILE = new URL('./.env.keys', import.meta.url).pathname;

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const report = (line: string) => process.stdout.write(`${line}\n`);

type Envelope<T> = { success: boolean; data: T; error: { code: string; message: string } | null };

let session = '';

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T; error: Envelope<T>['error']; response: Response }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = (text ? JSON.parse(text) : {}) as Partial<Envelope<T>> & T;
  const data = ('data' in parsed ? parsed.data : parsed) as T;
  return { status: response.status, data, error: parsed.error ?? null, response };
}

function check(label: string, result: { status: number; error: { code: string; message: string } | null }) {
  if (result.status >= 400) {
    throw new Error(
      `${label} failed: ${result.status} ${result.error?.code ?? ''} ${result.error?.message ?? ''}`
    );
  }
  report(`${label}: ${result.status}`);
}

const email = env('DASHBOARD_OWNER_EMAIL');
const password = env('DASHBOARD_OWNER_PASSWORD');

const signUp = await call('POST', '/v1/auth/sign-up/email', { email, password, name: 'Ertem' });
report(`sign-up: ${signUp.status}${signUp.error ? ` ${signUp.error.code}` : ''}`);
const signIn = await call('POST', '/v1/auth/sign-in/email', { email, password });
check('sign-in', signIn);
session = signIn.response.headers.get('set-auth-token') ?? '';
if (!session) throw new Error('sign-in returned no set-auth-token header');

const workspaces = await call<{ items: Array<{ slug: string }> }>('GET', '/v1/workspaces');
if (!workspaces.data.items.some((workspace) => workspace.slug === WORKSPACE)) {
  check('create workspace', await call('POST', '/v1/workspaces', { name: 'Pool', slug: WORKSPACE }));
}
const inWorkspace = { 'buzzkit-workspace': WORKSPACE };

const tenants = await call<{ items: Array<{ slug: string }> }>('GET', '/v1/tenants', undefined, inWorkspace);
if (!tenants.data.items.some((tenant) => tenant.slug === 'staging')) {
  check(
    'create staging tenant',
    await call('POST', '/v1/tenants', { name: 'Staging', slug: 'staging' }, inWorkspace)
  );
}

const p8 = env('APNS_PRIVATE_KEY').replaceAll('\\n', '\n');
const tenantsToSetUp = [
  { slug: 'default', label: 'PRODUCTION', bundleId: 'com.randomaccessmemories.pool' },
  { slug: 'staging', label: 'STAGING', bundleId: 'com.randomaccessmemories.pool.debug' },
] as const;

const existingKeys = await call<{ items: Array<{ name: string }> }>(
  'GET',
  `/v1/workspaces/${WORKSPACE}/keys?limit=100`,
  undefined,
  inWorkspace
);
const keyNames = new Set(existingKeys.data.items.map((key) => key.name));
let savedCount = 0;
const save = (line: string) => {
  appendFileSync(KEYS_FILE, `${line}\n`, { mode: 0o600 });
  savedCount += 1;
};

for (const tenant of tenantsToSetUp) {
  const inTenant = { ...inWorkspace, 'buzzkit-tenant': tenant.slug };
  check(
    `${tenant.slug}: require identity verification`,
    await call(
      'PATCH',
      `/v1/tenants/${tenant.slug}`,
      { settings: { identity: { requireVerification: true } } },
      inWorkspace
    )
  );
  for (const environment of ['production', 'sandbox'] as const) {
    check(
      `${tenant.slug}: APNs ${environment} for ${tenant.bundleId}`,
      await call(
        'POST',
        '/v1/credentials',
        {
          provider: 'apns',
          p8,
          teamId: env('APNS_TEAM_ID'),
          keyId: env('APNS_KEY_ID'),
          bundleId: tenant.bundleId,
          environment,
        },
        inTenant
      )
    );
  }

  const serverKeyName = `Convex ${tenant.slug}`;
  if (!keyNames.has(serverKeyName)) {
    const serverKey = await call<{ secret: string }>(
      'POST',
      `/v1/workspaces/${WORKSPACE}/keys`,
      {
        name: serverKeyName,
        kind: 'tenant',
        tenant: tenant.slug,
        scopes: ['messages:send', 'messages:read', 'subscribers:read', 'subscribers:write'],
      },
      inWorkspace
    );
    check(`${tenant.slug}: server key`, serverKey);
    save(`BUZZKIT_${tenant.label}_API_KEY='${serverKey.data.secret}'`);
  }
  const clientKeyName = `Pool iOS ${tenant.slug}`;
  if (!keyNames.has(clientKeyName)) {
    const clientKey = await call<{ secret: string }>(
      'POST',
      `/v1/workspaces/${WORKSPACE}/keys`,
      { name: clientKeyName, kind: 'client', tenant: tenant.slug },
      inWorkspace
    );
    check(`${tenant.slug}: client key`, clientKey);
    save(`BUZZKIT_${tenant.label}_CLIENT_KEY='${clientKey.data.secret}'`);
  }
  const identity = await call<{ identitySecret: string }>(
    'GET',
    `/v1/tenants/${tenant.slug}/identity-secret`,
    undefined,
    inWorkspace
  );
  check(`${tenant.slug}: identity secret`, identity);
  save(`BUZZKIT_${tenant.label}_IDENTITY_SECRET='${identity.data.identitySecret}'`);
}

report(`saved ${savedCount} values to pool/.env.keys`);

await call('POST', '/v1/auth/sign-out', {});
