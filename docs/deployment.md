# Deployment (Vercel)

The app deploys to Vercel as a Next.js project. The Vercel project exists; the first
production deployment is pending the user-only unblock steps below (they need a browser
login or a credential that never leaves your machine, so automation cannot perform them).

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

Production URL: recorded here once the first deployment exists
(expected pattern `https://meta-hack-<hash>-yifus-projects-5c1c92b8.vercel.app`).

## Unblock steps (user-only)

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
| `DATABASE_URL` | Deferred | Wired when the data model milestone lands. Vercel Postgres provisioning is not automatable via the connector; add the Postgres store and set `DATABASE_URL` in Vercel env settings at that point. |

## Per-PR preview deployments

Once step 1 and step 2 are done, previews are automatic for every pull request: Vercel
posts a preview URL comment on each PR (the project already has
`gitComments.onPullRequest: true` and `gitProviderOptions.createDeployments` enabled on
linking). Until the GitHub App is installed there is no git integration, so no preview
URLs can be generated for PRs.
