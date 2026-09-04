# Pull request template (deploy kit)

## Summary
This PR introduces the deploy/ kit for OrahDEX with local compose, Dockerfile templates, CI lint/build/scan pipelines, and cloud deploy stubs for GCP and Azure.

## What I changed
- Added deploy/docker-compose.yml (local compose with migration and healthchecks)
- Added deploy/Dockerfile and deploy/Dockerfile.frontend (multi-stage, non-root)
- Added deploy/.env.example
- Added deploy/.dockerignore and deploy/scripts/migrate-db.sh (placeholder)
- Added CI workflow: .github/workflows/ci.yml (hadolint, build, trivy, smoke)
- Added .github/workflows/deploy-gcp.yml stub and deploy/gcp/cloudbuild.yaml

## Checklist
- [ ] No real secrets committed (please verify)
- [ ] Adapt Dockerfile build commands to actual monorepo workspace names if needed
- [ ] Fill in cloud deploy steps and secrets (GCP SA, secrets) before running deploy workflows

## Testing steps
See deploy/README.md for local validation steps.
