# AGENTS

## Scope

This repository implements a self-hosted relay for ZCode web remote control.
It is not a fork of ZCode; it speaks the wire protocol documented in
`docs/protocol.md`.

## Required Reading

- Before changing protocol behaviour, MUST read `docs/protocol.md`.
- Before changing the relay design, MUST read `docs/design.md`.
- Before changing the SPA patch tooling, MUST read `docs/patching.md`.
- Before relying on an assumption about the vendor client, MUST check
  whether `docs/verification.md` already records evidence for it. If it does
  not, verify it empirically and add it there.

## Runtime

- TypeScript runs directly under Node 24 type stripping. There is NO build
  step and there MUST NOT be one.
- Only erasable TypeScript syntax is allowed: no enums, no parameter
  properties, no namespaces. `tsconfig.json` enforces this with
  `erasableSyntaxOnly`.
- Relative imports MUST carry the `.ts` extension.
- The only runtime dependency is `ws`.

## Tests

- Production code and test bodies MUST live in separate files.
- Test files MUST match `test/**/*.test.ts`; helpers MUST NOT use the
  `.test.ts` suffix.
- Every bug fix MUST add a regression test in the same commit.
- The command `just test` and `just lint` MUST pass.

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

## Vendor Assets

Vendor SPA bundles, patched output, and fetched assets MUST NOT be committed.
They are copyrighted vendor code; committing them is redistribution.
`.gitignore` enforces this.
