# Pool's BuzzKit deployment

Pool sends every push notification through this self-hosted BuzzKit (POOL-1511). The
branch `pool` is upstream `buzzkit-dev/buzzkit` plus Pool's Wrangler configuration and
this folder. Keep it that way: no application code changes, so an upgrade is a rebase.

| Piece | Where |
| --- | --- |
| API Worker `pool-buzzkit-api` | `https://push-api.pool.day` (public: the iOS SDK calls `/v1/client/*`) |
| Dashboard Worker `pool-buzzkit-web` | `https://push.pool.day` |
| Cloudflare account | Pool, `5f4ee34fe9caef1d02a43fa2af4e5a67` (Workers Paid) |
| PostgreSQL | PlanetScale Postgres in the Pool org, database `buzzkit` owned by role `buzzkit`, through Hyperdrive `pool-buzzkit-postgres` (query caching off) |
| Tinybird | Workspace `pool_staging`, AWS us-east (`https://api.us-east.aws.tinybird.co`) |
| KV, queues | `pool-buzzkit-*`, created by `pool/provision.sh` |
| Secrets | 1Password, Pool account, Shared vault, item `BuzzKit` |

Tenants inside the one workspace separate Pool's environments: `default` serves the
production app (`com.randomaccessmemories.pool`) and production Convex; `staging` serves
Debug and Staging builds (`com.randomaccessmemories.pool.debug`) and the staging and dev
Convex deployments. Each Convex deployment gets a tenant-locked `bk_tn_` key for its own
tenant only.

## Credentials stay local

Every command runs through `pool/run`, which loads `pool/.env` (git-ignored, mode 600) into
that one process. Wrangler then uses `CLOUDFLARE_API_TOKEN` and never reads or writes the
global login in `~/Library/Preferences/.wrangler`; pscale gets `--service-token-id`,
`--service-token` and `--org` on each call instead of `pscale auth login`. Other projects'
logins on the same Mac are untouched.

`pool/.env` holds:

```
CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   # Hyperdrive, Workers, KV, Queues, Routes, DNS, WAF
TINYBIRD_TOKEN, TINYBIRD_URL                  # pool_staging workspace admin token
BETTER_AUTH_SECRET, CREDENTIAL_MASTER_KEY_V1, SQIDS_ALPHABET
BUZZKIT_DATABASE_URL                          # buzzkit role, for migrations and Hyperdrive
PLANETSCALE_ORG, PLANETSCALE_SERVICE_TOKEN_ID, PLANETSCALE_SERVICE_TOKEN
DASHBOARD_OWNER_EMAIL, DASHBOARD_OWNER_PASSWORD
APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY   # uploaded through the API, never a Worker secret
```

Refresh it from 1Password in one session (one Touch ID prompt) with
`op item get BuzzKit --vault Shared --account pool-team.1password.com`.

## Provisioning

1. **Database.** In the Pool PlanetScale org, a Postgres database with a temporary admin
   role creates database `buzzkit`, owned by a dedicated `buzzkit` role that cannot read
   anything else:

   ```bash
   pool/run sh -c 'pscale role create <db> main buzzkit-setup --inherited-roles postgres --ttl 1h \
     --org "$PLANETSCALE_ORG" --service-token-id "$PLANETSCALE_SERVICE_TOKEN_ID" \
     --service-token "$PLANETSCALE_SERVICE_TOKEN" --format json'
   # As buzzkit-setup: CREATE ROLE buzzkit LOGIN PASSWORD '…'; CREATE DATABASE buzzkit OWNER buzzkit;
   # REVOKE ALL ON DATABASE buzzkit FROM PUBLIC;
   # then: pscale role reassign … --successor buzzkit, and delete buzzkit-setup.
   ```

   The temporary role cannot be dropped while it owns objects; reassign first.
2. **Cloudflare.** `pool/run pool/provision.sh` creates or finds the KV namespaces, the six
   queues and Hyperdrive, and writes their ids over the `PROVISION:` placeholders in
   `apps/api/wrangler.jsonc`. Commit the result.
3. **Schema.** `pool/run bun run --cwd packages/database db:migrate` with
   `DATABASE_URL=$BUZZKIT_DATABASE_URL`, then `pool/run bun run --cwd packages/tinybird deploy`.
   Never `db:push` or the upstream `*:production` helpers.
4. **Secrets and deploy.** From `apps/api`: put `BETTER_AUTH_SECRET`,
   `CREDENTIAL_MASTER_KEY_V1`, `SQIDS_ALPHABET` and `TINYBIRD_TOKEN` with
   `bunx wrangler secret bulk`, then `bunx wrangler deploy`. From `apps/web`: `bun run build`
   then `bunx wrangler deploy`. Both through `pool/run`. Upstream needs Workers Paid: on Free
   the API upload fails with "Script startup exceeded CPU time limit".
5. **Lock sign-up.** A zone WAF custom rule on `pool.day` blocks
   `http.host eq "push-api.pool.day" and starts_with(http.request.uri.path, "/v1/auth/sign-up")`.
   Create the owner account first; lift the rule briefly to add a teammate (invites need an
   Email Sending binding this deployment does not have).
6. **Workspace.** Sign in as the owner (`POST /v1/auth/sign-in/email` with
   `Origin: https://push.pool.day`, token from the `set-auth-token` header, then
   `Authorization: Bearer` plus `buzzkit-workspace: pool`):
   - create workspace `pool` and tenant `staging` beside `default`;
   - upload the APNs key to each tenant twice, once per `environment` (`sandbox`,
     `production`), with that tenant's bundle id: `default` → `com.randomaccessmemories.pool`
     (Release), `staging` → `com.randomaccessmemories.pool.debug` (Debug and Staging). The
     SDK registers each device under the environment of its provisioning profile, so a
     TestFlight Staging build needs the production slot too. Omitting `environment` fills
     both slots with one bundle id;
   - turn on `identity.requireVerification` for both tenants, so a device can only claim a
     user id signed by Convex;
   - create one tenant-locked server key per tenant with `messages:send` (messages, Live
     Activities), `messages:read`, `subscribers:read` and `subscribers:write` (imports,
     deletion), and read each tenant's client key and identity secret; they go to the
     matching Convex deployment and app build.
7. **Verify.** `GET https://push-api.pool.day/v1/health` reports the database `ok`; the
   dashboard serves `/login`; a test message reaches a Debug build. APNs cannot be
   exercised from `wrangler dev` on macOS, only against the deployed Worker.

## Upgrading

`git fetch upstream && git rebase upstream/main`, review the diff of both Wrangler files,
rehearse new migrations against a PlanetScale branch, then migrate, deploy the API, deploy
the dashboard. A Worker rollback does not roll back Postgres migrations, Durable Object
state or queued sends.
