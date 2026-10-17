# Contributing to OpenClipnest

Thanks for wanting to help.

## What belongs here

OpenClipnest is the core of Clipnest: camera upload, storage, processing,
browsing, playback, notifications, the MCP endpoint, and the install itself.
Fixes and improvements to any of that are welcome.

A few things are deliberately out of scope, and pull requests for them will
be closed so nobody spends time on work that cannot be merged:

- **More than one account.** An install has exactly one account. Sign-up,
  inviting other people, roles and sharing are not planned.
- **Features of the hosted service** — plans and billing, e-mail, passkeys,
  social sign-in.
- **A different push delivery path that bundles publisher credentials.** The
  apps can only be reached with their publisher's keys; that is what the
  relay is for.

If you are unsure whether an idea fits, open an issue before writing code.

## Development

```bash
npm ci --legacy-peer-deps
(cd frontend && npm ci --legacy-peer-deps)

npm test                      # server
(cd frontend && npm test)     # web app
npx vitest run --root clipnest-mcp   # MCP server
(cd ftps-server && cargo test)
node --test 'scripts/*.test.mjs'     # install: .env.example, compose file
npx eslint .
```

`node scripts/smoke-test.mjs` installs the whole stack from scratch with
Docker, exactly as the README describes, and checks it end to end (it uses its
own compose project and settings, so it does not touch an install on the same
machine). Run it before a pull request that touches the install, the upload
path or the database schema.

Keep pull requests focused: one change, with tests for the behaviour it
changes. Database changes are additive migrations — never edit an existing
migration file.

## Contributor licence agreement

Before your first pull request can be merged, you need to sign the
[CLA](CLA.md). A bot comments on the pull request with instructions; you sign
by replying with one sentence, once, and it covers all your later
contributions.

Why: OpenClipnest is also the base of a commercial product. The CLA lets the
project's owner include your contribution there as well, while your
contribution stays available to everyone in this repository under its licence
(PolyForm Noncommercial 1.0.0).
You keep the copyright to your work.

## Reporting bugs

Include what you did, what you expected, what happened, and the relevant part
of `docker compose logs`. Remove passwords and secrets before pasting.
