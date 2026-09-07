
# ── CLI ───────────────────────────────────────────────────────────────────────
# The whole repository, both runtimes, no server. Lagoon keeps this pod idle and
# execs post-rollout tasks and cronjobs into it, which is why it mounts the same
# volume as the backend service rather than one of its own.
#
# It carries Node and node_modules where the backend does not, because the
# tooling under scripts/ is JavaScript and shares helpers in scripts/lib/. The
# cronjobs run both: `server catalog` (Go) and `node scripts/…` (JavaScript).
#
# APP_ROOT is not set. Nothing here serves pages, and the scripts find the
# frontend the way they always have — `scripts/lib/roots.js` derives it from the
# repository root, which is this image's working directory.
FROM ${NODE_BUILDER_IMAGE} AS deps
WORKDIR /app
# corepack pins pnpm to the version in package.json's `packageManager`, so the
# image installs with the same one used locally and in CI. The prompt is
# disabled because a build has no terminal to answer it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --frozen-lockfile is the deploy-time contract: fail rather than quietly resolve
# a dependency the lockfile did not sanction. Install scripts stay blocked unless
# pnpm-workspace.yaml allows them by name.
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS cli
WORKDIR /app

ENV NODE_ENV=production \
    CONTENT_PATH=/storage

COPY . /app
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=go-tools /out/ /usr/local/bin/

RUN mkdir -p /storage/public/img /storage/private \
    && fix-permissions /app \
    && fix-permissions /storage

CMD ["/bin/docker-sleep"]
