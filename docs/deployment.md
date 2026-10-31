# Deployment (Vercel)

The app deploys to Vercel as a Next.js project. The Vercel project exists and is linked
to this repository (`productionBranch: main`), so every push to `main` deploys production
and every pull request gets a preview deployment. The user-only steps below are kept for
reference; all of them are complete as of 2026-10-29. The first production deployment
went out with PR #34, the first merge to the linked repo.

## Project facts

| Item | Value |
| --- | --- |
| Vercel account | `yifu001` (hobby plan) |
| Team slug | `yifus-projects-5c1c92b8` |
| Project name | `meta-hack` |
| Project ID | `prj_0TPwwgJBN83bPvXbQkzOj5phampr` |
| Framework preset | `nextjs` (build and install commands are Vercel defaults) |
| Region | `iad1` |
| Dashboard | `https://vercel.com/yifus-projects-5c1c92b8/meta-hack` |

Production URL: `https://meta-hack-omega.vercel.app` (aliases
`https://meta-hack-yifus-projects-5c1c92b8.vercel.app` and
`https://meta-hack-git-main-yifus-projects-5c1c92b8.vercel.app`). First production
deployment went live 2026-10-29 from `main` @ 9070d58 (PR #34).

## Unblock steps (user-only; all complete as of 2026-10-29)

1. **Install the Vercel GitHub App on the `meta-ai-hackathon` org.** Go to
   `https://github.com/apps/vercel/installations/new` (org-admin browser session), pick
   `meta-ai-hackathon`, and grant access to `meta-hack`. The Vercel API rejects repo
   linking without it ("To link a GitHub repository, you need to install the GitHub
   integration first"), and push-to-deploy plus per-PR previews both depend on it.
2. **Link the repo.** Project → Settings → Git → Connect Git Repository →
   `meta-ai-hackathon/meta-hack`, production branch `main`. From then on, every push to
   `main` deploys production and every pull request gets its own preview deployment.
3. **First production deploy.** After linking, push to `main` (or merge any PR) and
   Vercel builds it; alternatively run `npx vercel login && npx vercel deploy --prod`
   from the repo root. Record the URL above.
4. **Set `MODEL_API_KEY` in Vercel env settings (never in the repo).** Project →
   Settings → Environment Variables → add `MODEL_API_KEY` for Production, Preview, and
   Development. The value lives in the repo's local `.env` (gitignored). To add it via
   CLI without the value entering shell history or logs:

   ```sh
   grep '^MODEL_API_KEY=' .env | cut -d= -f2- | npx vercel env add MODEL_API_KEY production preview development
   ```

   Run from the repo root while logged in (`npx vercel login`). No tracked file may
   contain the value.
5. **Deployment protection.** New Vercel projects enable Standard Protection (SSO) by
   default, so `curl https://<prod-url>/api/health` redirects to a login page instead of
   returning 200. Project → Settings → Deployment Protection → disable Standard
   Protection (or issue a protection-bypass token for automated checks).

## Verifying a deployment

```sh
curl -sS https://<prod-url>/api/health    # expect {"ok":true} with HTTP 200
```

`/api/health` is static and does not touch the database, so it works before any
database wiring exists.

## Environment variables

| Var | Where | Notes |
| --- | --- | --- |
| `MODEL_API_KEY` | Vercel project env (Production, Preview, Development) | Meta Model API rail. Value from local `.env` only; documented in `.env.example`; never committed or logged. |
| `DATABASE_URL` | Vercel project env (Production, Preview), set by the connected Vercel Postgres store | Wired 2026-10-29: the managed store is provisioned and connected, auto-setting `DATABASE_URL` and its companion Postgres vars. Env changes apply to new deployments only. The DSN is never committed or logged; apply migrations from a machine that has it (see the README's Production section). |
| `VAULT_ENC_KEY` | Vercel project env (Production, Preview) | Required. The vault encrypts private answers with it: 64 hex characters, made with `openssl rand -hex 32`, documented in `.env.example`. Without it every page that reads a session fails, and changing it leaves any session that already holds a private answer unreadable (see `docs/runbooks.md`). Never committed or logged. Not confirmed set as of 2026-10-31. |
| `ELEVENLABS_API_KEY` | Vercel project env (Production, Preview) | Optional. Spoken replies go through ElevenLabs with it; without it the browser's built-in voice reads replies, with a visible notice. Documented in `.env.example`. Not confirmed set as of 2026-10-31. |

## Per-PR preview deployments

Previews are automatic for every pull request now that the GitHub App is installed and
the repo is linked: Vercel builds a preview deployment for each PR and posts its URL as
a PR comment (`gitComments.onPullRequest: true`). Verified on PR #34 — its preview
deployment (`meta-hack-r8jr6ft85-yifus-projects-5c1c92b8.vercel.app`, commit 2954917)
serves `/api/health` with HTTP 200. (The project's
`gitProviderOptions.createDeployments` reads `disabled`; as observed on PR #34, that
setting does not gate Vercel preview builds.)
