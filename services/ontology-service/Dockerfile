# ---------------------------------------------------------------------------
#  Ontology service: serves the generated ontology, object-set queries, KPIs,
#  lineage and actions, using @ontograph/core.
#
#  THE DIRECTORY LAYOUT IS DELIBERATE. package.json declares the library as
#  "@ontograph/core": "file:../../vendor/ontograph-core", which resolves on the
#  host from services/ontology-service. Placing the service at
#  /srv/app/service and the vendored clone at /srv/vendor/ontograph-core makes
#  that same relative path resolve inside the image, so package.json needs no
#  build-time rewriting and `npm install` behaves identically in both places.
#
#  The clone arrives through the `ontograph` named build context declared in
#  docker-compose.yml, because a build context cannot reach outside itself.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

# node:22-alpine ships npm 10.9.8, whose peer-dependency resolver crashes with
# "Cannot read properties of null (reading 'edgesOut')" on the vendored library's
# devDependency set. Fixed in npm 11.
RUN npm install -g npm@11.11.0 --no-audit --no-fund

# The vendored library, compiled from source rather than pulled from npm.
WORKDIR /srv/vendor/ontograph-core
COPY --from=ontograph package.json tsconfig.json tsconfig.build.json ./
# Only the compiler and node types, pinned. The library's other devDependencies
# (Biome, vitest, bun types) are lint and test tooling that compiling never
# touches, and zod - its one runtime dependency - is not imported by any source
# file, so it is left to the runtime stage to install.
RUN npm install --no-save --no-audit --no-fund typescript@6.0.3 @types/node@26.6.2
COPY --from=ontograph src ./src
# tsconfig.build.json emits CommonJS with rootDir=src, so the output lands at
# dist/index.js where package.json says it will. The nested package.json pins the
# module type, because the root package.json declares "type": "module" and the
# emitted files are CommonJS.
RUN npx tsc -p tsconfig.build.json \
    && echo '{"type":"commonjs"}' > dist/package.json

WORKDIR /srv/app/service
# npm ci rather than npm install: it installs exactly what package-lock.json
# describes and fails if the lock and the manifest disagree, so two builds of
# the same commit produce the same tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

RUN npm install -g npm@11.11.0 --no-audit --no-fund

# Python, for the transforms a `python` code repository runs. The standard
# library only: the runner deliberately has no third-party dependency, so a
# transform gets the same interpreter everywhere and the image gains ~50 MB
# rather than the ~300 MB a scientific stack would cost. See
# src/pythonTransforms.ts for what a transform may and may not reach.
RUN apk add --no-cache python3

# The compiled library: its dist and manifest only, so no dev toolchain is
# carried into the runtime image.
WORKDIR /srv/vendor/ontograph-core
COPY --from=build /srv/vendor/ontograph-core/package.json ./
COPY --from=build /srv/vendor/ontograph-core/dist ./dist

WORKDIR /srv/app/service
COPY package.json package-lock.json ./
# Installs runtime deps and links the vendored library, hoisting its own
# dependency (zod) into this node_modules.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /srv/app/service/dist ./dist
# The transform runner, beside the compiled service so dist/../python resolves.
COPY python ./python

RUN addgroup -g 10003 svc && adduser -u 10003 -G svc -D svc \
    && chown -R svc:svc /srv
USER svc

EXPOSE 4000
CMD ["node", "dist/index.js"]
