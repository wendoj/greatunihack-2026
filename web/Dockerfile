# Ridgeline web (Next.js standalone). Build context: repo root.
#   docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_BRIDGE_URL=https://bridge.example.com .
FROM node:22-bookworm-slim AS build
RUN npm install -g bun@1.3.3
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
# Next inlines NEXT_PUBLIC_* at build time, so the bridge URL is a build argument.
ARG NEXT_PUBLIC_BRIDGE_URL=http://localhost:4000
ENV NEXT_PUBLIC_BRIDGE_URL=$NEXT_PUBLIC_BRIDGE_URL NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
