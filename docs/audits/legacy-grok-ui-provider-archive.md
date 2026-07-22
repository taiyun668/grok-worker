# Legacy Grok UI Provider archive record

## Authorized G7 result

The former code-only embedding was moved, without overwrite, from
`D:\Grok UI\.codex\grok-bridge\provider` to the neutral, non-runtime archive
`D:\Grok Worker Provider-legacy-archive\provider-v6-r8-20260722`.

Before the move, the source was a normal directory (not a reparse point). A
reference scan across the Provider feature/tagged source and Grok UI found zero
runtime references outside the legacy embedding. The scan excluded the legacy
embedding itself, documentation, and every `auth.json`; no credential content
was read, copied, or hashed.

The archive manifest enumerates 35 non-auth files. Its canonical UTF-8 JSON
path/SHA-256 digest is
`7e3b1f80fc178db760a575dbb68761c4f2972df8471e77177e9900f4c565e339`.
The archive is recoverable by moving that directory back only under a new,
explicit authorization; it is not a Provider runtime or release entrypoint.

## Deliberately retained credential-bearing residue

The following were inspected only for existence, attributes, and reparse-point
metadata. They were not read, copied, hashed, moved, or deleted because they
may contain account credentials:

- `%LOCALAPPDATA%\GrokUI\worker-provider`
- `%LOCALAPPDATA%\GrokUI\worker-profiles`
- `%LOCALAPPDATA%\GrokUI\codex-grok-workers`

They are inert legacy residues, not active Provider roots. Their future cleanup
requires a separate credential-safe authorization.
