# The hosted MCP server: `stillworks mcp --http --hosted`, for cloud builders (Lovable, Bolt, Replit) and remote
# connectors (claude.ai, ChatGPT) that connect to a URL instead of running npx on your machine.
#
#   docker build -t stillworks-mcp .
#   docker run -p 8787:8787 stillworks-mcp
#   → http://localhost:8787/mcp
#
# Hosted mode: check_app only, public URLs only, every request to a private network blocked, 20 checks per client
# per hour (STILLWORKS_RATE_LIMIT). Set STILLWORKS_MCP_TOKEN to require "Authorization: Bearer <token>".
# Keep the Playwright image's version equal to the playwright version in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NO_PUBLISHUB_PROMO=1 \
    PORT=8787

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY integrations ./integrations
RUN npm ci --include=dev --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev \
 && rm -rf src tsconfig.json

# the image's non-root user: the browser never runs as root
USER pwuser
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# --trust-proxy: Fly, Render and Railway put the client's address in X-Forwarded-For (used for the rate limit)
CMD ["node", "dist/cli.js", "mcp", "--http", "--hosted", "--trust-proxy"]
