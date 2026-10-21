# Pool's BuzzKit deployment

Pool sends every push notification through this self-hosted BuzzKit (POOL-1511). The
branch `pool` is upstream `buzzkit-dev/buzzkit` plus Pool's Wrangler configuration, this
folder and the few API additions Pool needs: `POST /v1/device-pushes/send` (Pool's own
alerts, silent sync pushes and Live Activity pushes to the tokens it registers), queue
routing by role whatever the queue prefix, and moved endpoints failing as `unsubscribed`.
Keep additions that small, so an upgrade stays a rebase.

| Piece | Where |
| --- | --- |
| API Worker `pool-buzzkit-api` | `https://push-api.pool.day` (public: the iOS SDK calls `/v1/client/*`) |
| Dashboard Worker `pool-buzzkit-web` | `https://push.pool.day` |
| Cloudflare account | Pool, `5f4ee34fe9caef1d02a43fa2af4e5a67` (Workers Paid) |
| PostgreSQL | PlanetScale org `randomaccessmemories`, cluster `buzzkit` (Postgres 17, AWS us-east-1, PS-10 with two replicas), database `buzzkit` owned by the PlanetScale role `buzzkit`, through Hyperdrive `pool-buzzkit-postgres` (query caching off) |
| Sign-up | Blocked by the zone WAF custom rule "BuzzKit: block dashboard sign-up" on `pool.day` |
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

`pool/.env.keys` holds what the workspace setup minted: per tenant (`PRODUCTION` is
`default`, `STAGING` is `staging`) the server key `BUZZKIT_<T>_API_KEY` for Convex, the
client key `BUZZKIT_<T>_CLIENT_KEY` and `BUZZKIT_<T>_IDENTITY_SECRET`. Both files are copies
of the Shared/`BuzzKit` item (Pool 1Password account); the Cloudflare token is its own
Shared item `CLOUDFLARE_API_TOKEN`, the PlanetScale service token the Shared item
`PlanetScale`.

The APNs key is the one production Convex sends with (`APNS_*` on the production
deployment). The `APNS_*` values in the 1Password `Development` and `Production` notes are
a key Apple rejects (`InvalidProviderToken`, checked 2026-10-20).

## Provisioning

1. **Database.** `pool/pscale` runs pscale as the service token (it creates the cluster and
   so holds full access to it). Create the runtime role `buzzkit` with no inherited roles
   and a one-hour admin role, `pool/run pool/pscale role create buzzkit main buzzkit-setup
   --inherited-roles postgres --ttl 1h --org randomaccessmemories`. As the admin role:
   `CREATE DATABASE buzzkit; REVOKE ALL ON DATABASE buzzkit FROM PUBLIC;`. The admin role
   cannot `ALTER DATABASE … OWNER` to the runtime role (it may not `SET ROLE` to it), so hand
   ownership over with `pscale role reassign buzzkit main <admin role id> --successor
   <runtime role username>`, then delete the admin role. The runtime role's
   `database_url` with path `/buzzkit` is `BUZZKIT_DATABASE_URL`.
2. **Cloudflare.** `pool/run pool/provision.sh` creates or finds the KV namespaces, the six
   queues and Hyperdrive, and writes their ids over the `PROVISION:` placeholders in
   `apps/api/wrangler.jsonc`. Commit the result.
3. **Schema.** `pool/run pool/migrate` (checked-in Drizzle migrations against
   `BUZZKIT_DATABASE_URL`), then `pool/run bun run --cwd packages/tinybird deploy`.
   Never `db:push` or the upstream `*:production` helpers.
4. **Secrets and deploy.** From `apps/api`: `bunx wrangler deploy --secrets-file <json>` with
   `BETTER_AUTH_SECRET`, `CREDENTIAL_MASTER_KEY_V1`, `SQIDS_ALPHABET` and `TINYBIRD_TOKEN`
   (write the file from `pool/.env` and delete it after). From `apps/web`: `bun run build`
   then `bunx wrangler deploy`. Both through `pool/run`. Upstream needs Workers Paid: on Free
   the API upload fails with "Script startup exceeded CPU time limit".
5. **Workspace.** `pool/run bun pool/setup-workspace.ts` signs up the owner, then does the
   steps below as that session (`Origin: https://push.pool.day`, token from the
   `set-auth-token` header, then `Authorization: Bearer` plus `buzzkit-workspace: pool`). It
   skips what exists and writes what it mints to `pool/.env.keys`:
   - create workspace `pool` and tenant `staging` beside `default`;
   - upload the APNs key to each tenant twice, once per `environment` (`sandbox`,
     `production`), with that tenant's bundle id: `default` → `com.randomaccessmemories.pool`
     (Release), `staging` → `com.randomaccessmemories.pool.debug` (Debug and Staging). Pool's
     Convex imports every device itself (the SDK never registers one) under its
     deployment's `APNS_ENVIRONMENT`, the environment it sends silent pushes with, so the
     slot that matters is the one that environment names; uploading both keeps either
     working. Omitting `environment` fills both slots with one bundle id;
   - turn on `identity.requireVerification` for both tenants, so a device can only claim a
     user id signed by Convex;
   - create one tenant-locked server key per tenant with `messages:send` (messages and the
     device pushes: Pool's alerts, sync wakes and Live Activities), `messages:read`, `subscribers:read` and `subscribers:write` (imports,
     deletion), a client key per tenant, and read each tenant's identity secret; they go to
     the matching Convex deployment (`BUZZKIT_API_URL`, `BUZZKIT_API_KEY`,
     `BUZZKIT_CLIENT_KEY`, `BUZZKIT_IDENTITY_SECRET`).
6. **Lock sign-up.** A zone WAF custom rule on `pool.day` blocks
   `http.host eq "push-api.pool.day" and starts_with(http.request.uri.path, "/v1/auth/sign-up")`.
   Add it to the zone's existing custom ruleset (never `PUT` the entrypoint over rules that
   are there). Lift it briefly to add a teammate: invites need an Email Sending binding this
   deployment does not have.
7. **Verify.** `GET https://push-api.pool.day/v1/health` reports the database `ok`; the
   dashboard serves `/login`; a test message reaches a Debug build. APNs cannot be
   exercised from `wrangler dev` on macOS, only against the deployed Worker.

## Sending broadcasts

Pool's admin no longer composes broadcasts (its `/broadcasts` redirects here). Send them from this
dashboard: tenant `default` reaches the App Store app, `staging` reaches Debug and Staging builds.
Pool's Convex keeps every device a subscription under the account's Convex user id, so a message
reaches each of an account's devices once, and BuzzKit keeps its deliveries and opens.

Audiences are segments or inline conditions. Pool sets these attributes on every subscriber with
each import of its devices, and merges them again when the account finishes an import or changes
its review-request choice:

| Attribute | Value |
| --- | --- |
| `accountCreatedAt` | when the account was made |
| `lastImportAt` | when it last finished a multi-screenshot import |
| `reviewRequestOptIn` | whether it agreed to review-request pushes |
| `lastReviewRequestAt` | the last review-request push Pool's own broadcasts sent it |

Dates are ISO strings, which BuzzKit compares as text, so a bare date stands for the start of
that day: `gte: "2026-10-14"` is on or after it, `lt: "2026-10-14"` is before it. Pool's former
audiences:

- Every push-enabled account: `{ "channel": "push" }`.
- Recent importers, here the 7 days before 2026-10-21:
  `{ "all": [{ "channel": "push" }, { "ref": "attributes.lastImportAt", "gte": "2026-10-14" }] }`.
- A review request: only accounts that opted in, are at least 14 days old and imported recently,
  and got no review request in 90 days:
  `{ "all": [{ "channel": "push" }, { "ref": "attributes.reviewRequestOptIn", "eq": true },
  { "ref": "attributes.accountCreatedAt", "lt": "<14 days ago>" },
  { "ref": "attributes.lastImportAt", "gte": "<start of the window>" },
  { "any": [{ "ref": "attributes.lastReviewRequestAt", "exists": false },
  { "ref": "attributes.lastReviewRequestAt", "lt": "<90 days ago>" }] }] }`.
  `lastReviewRequestAt` only records Pool's own past sends, so also leave out the recipients of any
  review request sent here in the last 90 days.

To open a page when the push is tapped, set the message's `data.url`: the app opens a `pool://`
link in the app, and `https://pool.day/notifications/open?notification_type=admin_broadcast&source_id=<campaign>&destination_url=<encoded https URL>`
opens an external page.

## Pushing this branch

The pre-push hook's `bun check-types` regenerates the API's Worker types from
`apps/api/wrangler.jsonc`, which has no `EMAIL` binding, so `libs/email.ts` fails to
typecheck. At runtime the missing binding throws inside its `try`, and an invite reports
`emailSent: false`. Run `bun run test` (the hook's other half), restore the regenerated
`apps/api/worker-configuration.d.ts`, and push with `--no-verify`.

## Upgrading

`git fetch upstream && git rebase upstream/main`, review the diff of both Wrangler files,
rehearse new migrations against a PlanetScale branch, then migrate, deploy the API, deploy
the dashboard. A Worker rollback does not roll back Postgres migrations, Durable Object
state or queued sends.
