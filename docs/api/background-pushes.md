# Background pushes

Silent APNs pushes to device tokens the caller owns: the backend wakes an app in the background without showing anything. Built for a backend that already keeps its own device registry and schedules its own wakes, so it needs each token's APNs outcome back to retire dead tokens and back off. Tenant-context routes: a tenant key implies its tenant; workspace keys and sessions select one with `buzzkit-tenant`.

## The push

A background push is an APNs push with `apns-push-type: background`, `apns-priority: 5`, topic `<bundleId>` and the body `{"aps":{"content-available":1}, ...data}` (`providers/apns/payload.ts`, `providers/apns/request.ts`). It goes out on the tenant's APNs credential for the request's environment. Nothing in the payload is BuzzKit's: no `bk` envelope, so the app handles it as its own.

`ttlSeconds` sets `apns-expiration`: omitted, the header is left out and APNs stores the push by its own storage policy; `0` asks APNs to try once and not store it; any other value stores it until that many seconds from now. iOS budgets background pushes and may defer or coalesce them, so they say "check for work", never carry anything time-critical.

## POST /v1/background-pushes/send

Scope `messages:send`. `{ tokens: string[], environment?: "production" | "sandbox", data?, collapseId?, ttlSeconds? }`:

- `tokens`: one to 100 hex APNs device tokens, matched lower-cased. They need not belong to a registered subscription.
- `environment`: the APNs environment of every token; `production` when omitted.
- `data`: keys merged into the payload root. `aps` and `bk` are refused with `400 data_key_reserved`.
- `collapseId`: `apns-collapse-id`.
- `ttlSeconds`: 0 to 28 days, as above.

It runs synchronously and records no message, no deliveries and no subscription changes, like `POST /v1/live-activities/send`. The response is `{ results: [{ token, ok, status, apnsId, code?, reason?, retryAfterSeconds? }] }`, one entry per token in request order:

- `status` is APNs's HTTP status, null when no response came back (`code: "transport"` or `"timeout"`).
- `apnsId` is APNs's `apns-id` for a sent push.
- `reason` is APNs's own reason (`BadDeviceToken`, `Unregistered`, `TooManyRequests`, ...), or `apns_status_<n>` when APNs gave none, so the caller can apply its own token policy; `code` is the shared delivery error code.
- Without an APNs credential for the environment every token reports `code: "no_credential"`.

Each push runs in a `deliveries.send` span with `delivery.ok` and `delivery.code`; the `backgroundPushes.send` span stamps `background_push.sent` and `background_push.failed`.
