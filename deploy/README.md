# OrahDEX deploy kit (Azure + Google Cloud)

Production packaging for [aaurah/OrahDEX](https://github.com/aaurah/OrahDEX).

## Contents

| Path | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage API image (Node 20, port 8080) |
| `Dockerfile.frontend` | Static frontend via nginx |
| `docker-compose.yml` | Local API + Postgres + frontend |
| `.env.example` | Required secrets (placeholders) |
| `gcp/deploy.sh` | One-shot Cloud Run deploy |
| `gcp/cloudbuild.yaml` | Cloud Build pipeline |
| `azure/deploy.sh` | One-shot ACR + Postgres + Container Apps |
| `azure/bicep/main.bicep` | Azure IaC starter |
| `scripts/migrate-db.sh` | Apply Drizzle SQL |
| `.github/workflows/deploy-gcp.yml` | GitHub Actions → Cloud Run |

## Critical production rules

1. **Replicas = 1** for the API until background workers (price, HTLC, funding, etc.) use distributed locks.
2. **CPU always allocated** on Cloud Run (`--no-cpu-throttling`) so intervals keep running.
3. **Heap** `NODE_OPTIONS=--max-old-space-size=4096`.
4. Put **secrets** in Azure Key Vault / GCP Secret Manager — never in git.
5. Apply DB schema **before** first traffic (`scripts/migrate-db.sh`).

## Quick start (local)

Important: this compose setup is for local development and testing only. Do NOT use docker-compose as-is for production. Remove port mappings and use a managed DB for production.

```bash
# 1. Clone OrahDEX and place this kit as deploy/ inside the repo
git clone https://github.com/aaurah/OrahDEX.git
cd OrahDEX
# copy this folder to ./deploy

# 2. Env
cp deploy/.env.example deploy/.env
# Edit deploy/.env and replace placeholders — do NOT commit real secrets

# 3. Validate compose file and build
cd deploy
# expands variables and checks for errors
docker compose -f docker-compose.yml config
# then start (builds images using the repo root as context)
docker compose -f docker-compose.yml up -d --build

# 4. (Optional) Run migrations manually if you prefer
# This kit includes a migrate service which tries to run deploy/scripts/migrate-db.sh
# You can also run it manually from repo root:
# DATABASE_URL='postgresql://orahdex:PASSWORD@localhost:5432/orahdex' ./deploy/scripts/migrate-db.sh ..
```

API: `http://localhost:8080` · Frontend: `http://localhost:8081`

## Notes & guidance

- The docker-compose file now requires deploy/.env with POSTGRES_PASSWORD set. There are no fallback defaults in the compose file.
- The Dockerfiles included are lightweight multi-stage examples that attempt to use pnpm workspaces. You may need to adapt build scripts if your monorepo uses different conventions.
- Healthchecks use curl; the API image installs curl so healthchecks should succeed.
- For production, use Cloud Run / Azure Container Apps with secret management (Key Vault / Secret Manager) and a managed Postgres instance. Do NOT expose Postgres on a public host in production.

## Install this kit into the repo

```bash
cd OrahDEX
mkdir -p deploy
# copy all files from this package into deploy/
# ensure Dockerfile paths match (build context = repo root)
```

Dockerfile expects monorepo layout:

```text
package.json
pnpm-workspace.yaml
lib/
artifacts/api-server/
artifacts/bsv-dex/
deploy/Dockerfile
```
