FROM node:22-alpine
# corepack ships with node and pins pnpm to the version in package.json's
# `packageManager`, so the image builds with the same one used locally and in CI.
RUN corepack enable
COPY . .
WORKDIR /
# --frozen-lockfile is the deploy-time contract: fail rather than quietly resolve a
# dependency the lockfile did not sanction. Install scripts stay blocked unless
# pnpm-workspace.yaml allows them by name.
RUN pnpm install --frozen-lockfile --prod

# Content lives OUTSIDE the image. The archive and this installation's private
# state are mounted at runtime (see docker-compose.yml), so the image carries the
# application only — no datasets, no images, no planners, no receipts.
#
# These must be ABSOLUTE. A relative root resolves against the repo root, which is
# `/` in this image, so `../anything` would resolve back to `/` and quietly serve
# the wrong tree.
ENV DATA_ROOT=/srv/data/public \
    IMG_ROOT=/srv/data/public/img \
    PRIVATE_ROOT=/srv/data/private

# Declared so `docker run` without -v still starts with writable locations rather
# than failing on a read-only layer. Mount real directories over them in practice:
# the public volume is written by the editor and by the catalog rebuild on boot,
# and the private volume holds planners, uploads and the curation ledger.
VOLUME ["/srv/data/public", "/srv/data/private"]

EXPOSE 8080
CMD ["node", "server.js"]
