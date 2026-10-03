# ---------------------------------------------------------------------------
#  UI: built with Vite, served by nginx, which also proxies the two APIs and
#  terminates TLS.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# npm ci, not npm install: it installs exactly the tree package-lock.json
# describes and fails if the lock and the manifest disagree, so the image is
# reproducible. (This was `npm install` with a comment saying no lock file was
# committed; services/ui/package-lock.json is committed, so that no longer
# held.)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# Served as-is from the site root: the favicon, and the pre-paint theme script.
COPY public ./public

# Typecheck before bundling. Vite's esbuild transform strips types without
# checking them, so without this a type error ships as a runtime bug.
RUN npx tsc -p tsconfig.json --noEmit
RUN npm run build

FROM nginx:1.27-alpine

# openssl is only needed for the self-signed fallback certificate.
RUN apk add --no-cache openssl

COPY --from=build /app/dist /usr/share/nginx/html
# A template, not the live config: the entrypoint writes conf.d/default.conf
# from it at start, filling in where the two APIs are (ONTOLOGY_SERVICE_URL,
# AI_FDE_URL), so moving their ports does not need a rebuild.
COPY nginx.conf /etc/nginx/default.conf.template
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# A checkout on Windows can hand this script over with CRLF line endings, and
# "#!/bin/sh\r" is not an interpreter: the container then fails to start with
# "no such file or directory". Stripped here so the image does not depend on
# how git was configured where it was built.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
