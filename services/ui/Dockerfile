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

# Typecheck before bundling. Vite's esbuild transform strips types without
# checking them, so without this a type error ships as a runtime bug.
RUN npx tsc -p tsconfig.json --noEmit
RUN npm run build

FROM nginx:1.27-alpine

# openssl is only needed for the self-signed fallback certificate.
RUN apk add --no-cache openssl

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
