# Ridgeline bridge + agents. One container, one bridge, N agent processes (separate OS
# processes talking UDP multicast inside this container). Never scale beyond 1 replica.
# Build context: repo root (the bridge reuses the agent code in web/lib/sim).
FROM oven/bun:1.3.3
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY web/lib/contract.ts /app/web/lib/contract.ts
COPY web/lib/sim /app/web/lib/sim
COPY server/src ./src
ENV PORT=4000 RESULTS_PATH=/app/server/data/results.json
RUN mkdir -p /app/server/data && chown -R bun:bun /app/server/data
USER bun
EXPOSE 4000
# Healthy only once the bridge hears its own agents over multicast (see /health).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/live/bridge.ts"]
