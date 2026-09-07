# ─────────────────────────────────────────────────────────────────────────────
# SHARED BUILD — identical in Dockerfile.backend and Dockerfile.cli.
#
# This file is not built directly. It is the single copy of the stages both
# images need, concatenated into each of them by `scripts/build-dockerfiles.mjs`
# — because Docker has no include, and two hand-maintained copies of a build
# drift the first time somebody edits one of them.
#
# Edit HERE, then run `pnpm run build:dockerfiles`. The generated files are
# committed, so Lagoon and `docker build` see ordinary self-contained
# Dockerfiles and need to know nothing about this.
#
# Content lives OUTSIDE both images. On Lagoon a persistent volume is mounted at
# /storage and CONTENT_PATH points the roots at it; locally the same path is a
# bind mount (see docker-compose.override.yml). The images carry the
# application only — no datasets, no images, no planners, no receipts.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_IMAGE=uselagoon/node-22
ARG NODE_BUILDER_IMAGE=uselagoon/node-22-builder
ARG GO_IMAGE=golang:1.26-alpine

# ── Go tools ──────────────────────────────────────────────────────────────────
# Every module under tools/ is built and its binaries land on the PATH. `./...`
# picks up whatever commands a module defines, so a second Go tool needs no
# change here.
FROM ${GO_IMAGE} AS go-tools
WORKDIR /src
COPY tools/ ./
RUN mkdir -p /out \
    && for module in */; do \
         if [ -f "${module}go.mod" ]; then \
           echo "building ${module}"; \
           (cd "${module}" && CGO_ENABLED=0 go build -trimpath -o /out/ ./...) || exit 1; \
         fi; \
       done \
    && ls -la /out
