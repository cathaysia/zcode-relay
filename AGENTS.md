# AGENTS

## Scope

This repository implements a self-hosted relay for ZCode web remote control.
It is not a fork of ZCode; it speaks the wire protocol documented in
`docs/protocol.md`.

## Required Reading

- Before changing protocol behaviour, MUST read `docs/protocol.md`.
- Before changing the relay design, MUST read `docs/design.md`.
- Before changing the SPA patch tooling, MUST read `docs/patching.md`.
- Before changing the asset-serving or HTTP layer, MUST read the asset-server
  invariants in `docs/design.md` §3.
- Before relying on an assumption about the vendor client, MUST check whether
  `docs/verification.md` already records evidence for it. If it does not,
  verify it empirically and add it there.

## Runtime

- The runtime is Deno. There is NO build step and there MUST NOT be one.
- `deno.json` holds the tasks, the import map and the compiler options. Tasks
  are the only supported entry points; `justfile` recipes delegate to them.
- Only erasable TypeScript syntax is allowed: no enums, no parameter
  properties, no namespaces. Deno strips types at load time and rejects
  anything it cannot erase, so the runtime enforces this itself.
- Relative imports MUST carry the `.ts` extension.
- `deno.lock` MUST be committed; dependency changes MUST update it.
- Runtime dependencies are `fastify`, `@fastify/websocket`, `ws` (used by
  `@fastify/websocket` and by the test client) and `@std/*`. Adding a
  dependency to the request path MUST be justified in the commit message.

## Deno-Specific Requirements

- Protocol crypto MUST use Web Crypto (`crypto.subtle`,
  `crypto.getRandomValues`) plus the `@std/encoding` base64 helpers. Node's
  `crypto` is a compatibility layer and MUST NOT be used for protocol values.
- `crypto.subtle` has no synchronous HMAC. Authentication work that awaits
  MUST be serialized per connection, so handling order still equals arrival
  order.
- Byte handling MUST use web-standard types (`Uint8Array`, `TextEncoder`,
  `TextDecoder`). `Buffer` MUST NOT be used.
- Node globals (`process`, `NodeJS.*`) MUST NOT be used; use `Deno.env`,
  `Deno.args`, `Deno.build.os`, `Deno.exit` and friends.
- Deno's `node:http` compatibility layer does not report the peer's TCP FIN on
  an upgraded WebSocket connection. Connection liveness MUST therefore be
  proven by relay-initiated pings (`src/relay/liveness.ts`); removing them
  silently disables `DEVICE_OFFLINE`.

## HTTP Layer (Fastify)

- Fastify owns transport mechanics: routing, method dispatch, automatic HEAD
  routes, 404/405, request/response plumbing, and stream teardown when a
  client aborts.
- These are domain decisions and MUST NOT be delegated to plugins
  (`@fastify/static`, `@fastify/etag`, `@fastify/compress`, ...): cache policy
  per resource class, per-representation ETags, the `Vary` scope, and which
  resources may be compressed at all. The reasons are recorded as the
  asset-server invariants in `docs/design.md` §3.
- Content negotiation MUST keep "an explicitly listed encoding wins over `*`"
  (RFC 9110 §12.5.3). `@fastify/accept-negotiator` violates this for
  `br;q=0, *`; it MUST NOT be used.
- Path routing MUST derive the filesystem path from the URL pathname after URL
  normalization (see `classifyRoute` in `src/assets/routes.ts`), not from the
  router's decoded wildcard parameter.
- WebSocket routes MUST be registered through `@fastify/websocket`, and live
  sockets MUST be terminated on close so shutdown does not wait on clients.

## Tests

- Production code and test bodies MUST live in separate files.
- Test files MUST match `test/**/*.test.ts`; helpers MUST NOT use the
  `.test.ts` suffix.
- Tests run under the Deno test runner (`deno test`, i.e. `just test`).
- Every bug fix MUST add a regression test in the same commit.
- The commands `just test` and `just lint` MUST pass.
- `deno fmt` is the only formatting authority (`just fmt`); the tree MUST stay
  formatted (`just fmt-check`). Markdown is excluded — `docs/` is hand-wrapped
  for CJK prose and ASCII diagrams.
- Optimising a test for a passing sanitizer MUST NOT weaken what it asserts.
  When a sanitizer cannot express the invariant, say so in a comment and keep
  an independent measurement. `test/assets-abort.test.ts` is the worked
  example.

## Vendor Asset Handling

- Vendor SPA bundles, patched output, and fetched assets MUST NOT be committed.
  They are copyrighted vendor code; committing them is redistribution.
  `.gitignore` enforces this.
- `fetch-assets` MUST NOT write anything except the fetched tree and
  `manifest.json`. It is a mirror; its sha256 values are the drift baseline.
- All vendor-tree rewrites MUST happen in memory at serve time. The entry
  bundle patch and the shell meta injection are the only two, and neither may
  mutate disk.
- A patched entry bundle MUST NOT be served with `immutable` cache headers —
  its content no longer matches the hash in its filename.
- `serve` MUST fail closed: if the entry patch cannot be applied, it MUST
  refuse to start. Starting unpatched silently sends the SPA to the vendor
  relay while the operator believes self-hosting is in effect.

## Protocol Constraints

These are load-bearing and MUST NOT be relaxed:

- `data` payloads MUST be forwarded byte-for-byte. The relay MUST NOT parse,
  re-serialize, reorder, or add fields inside `payload`.
- `pass_hash` MUST NOT be persisted to disk. It lives in memory only.
- Only the five error codes in `src/protocol/limits.ts` may be sent. Clients
  treat an unknown code as fatal and do not reconnect.
- `auth_ack` and `pair_status_ack` MUST always carry `pair_status`.
- After a device re-authenticates, the current status MUST be sent to it
  immediately. The device treats a `waiting` after reconnect as stale and
  reconnects on its own.
- Pair status MUST only be pushed when it actually changes, except in the
  mandatory send on authentication.
- No WS message larger than `MAX_PHYSICAL_FRAME_BYTES` may be sent.
