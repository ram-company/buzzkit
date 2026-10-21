# Device pushes

APNs pushes to device tokens the caller owns, with the payload and headers the caller builds: alerts, silent background pushes and Live Activity pushes. Built for a backend that keeps its own device and Live Activity token registry and its own payloads, so it needs BuzzKit only as the holder of the APNs key, and each token's APNs outcome back to retire dead tokens and back off. Tenant-context routes: a tenant key implies its tenant; workspace keys and sessions select one with `buzzkit-tenant`.

## POST /v1/device-pushes/send

Scope `messages:send`. `{ tokens: string[], pushType, payload, environment?, topic?, priority?, collapseId?, expiration? }`, each field the APNs request field of the same name:

- `tokens`: one to 100 hex APNs device tokens (or Live Activity push tokens), matched lower-cased. They need not belong to a registered subscription.
- `pushType`: `apns-push-type`, one of `alert`, `background` or `liveactivity`.
- `payload`: the request body, sent as given. It must hold an `aps` object (`400 payload_invalid`) and fit APNs's 4096 bytes (`400 payload_too_large`). BuzzKit adds nothing to it: no `bk` envelope, no `mutable-content`, so the app handles it as its own.
- `environment`: the APNs environment of every token, `production` when omitted; the push goes out on the tenant's APNs credential for it.
- `topic`: `apns-topic`. Omitted, it is the credential's bundle id, with `.push-type.liveactivity` for a Live Activity push. Set it to reach another app the same APNs key may push to, such as a debug build's bundle id.
- `priority`: `apns-priority`, `5` or `10`; `5` for a background push and `10` otherwise when omitted.
- `collapseId`: `apns-collapse-id`.
- `expiration`: `apns-expiration`, in seconds since the epoch. Omitted, the header is left out and APNs stores the push by its own policy; `0` asks APNs to try once and not store it.

It runs synchronously and records no message, no deliveries and no subscription changes, like `POST /v1/live-activities/send`. The response is `{ results: [{ token, ok, status, apnsId, code?, reason?, retryAfterSeconds? }] }`, one entry per token in request order:

- `status` is APNs's HTTP status, null when no response came back (`code: "transport"` or `"timeout"`).
- `apnsId` is APNs's `apns-id` for a sent push.
- `reason` is APNs's own reason (`BadDeviceToken`, `Unregistered`, `TooManyRequests`, ...), or `apns_status_<n>` when APNs gave none, so the caller can apply its own token policy; `code` is the shared delivery error code.
- Without an APNs credential for the environment every token reports `code: "no_credential"`.

Each push runs in a `deliveries.send` span with `delivery.ok` and `delivery.code`; the `devicePushes.send` span stamps `device_push.environment`, `device_push.push_type`, `device_push.sent` and `device_push.failed`.
