# UniQuake Docker Image
# Based on ssl-manager for automatic SSL certificate management and HAProxy integration

FROM ghcr.io/unicitynetwork/ssl-manager:latest

# ssl-manager is based on debian:trixie-slim and already includes:
#   certbot, openssl, curl, jq, netcat-openbsd, python3, procps, ca-certificates

# Install Node.js, npm, build tools (for native module rebuild), and tini
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs \
        npm \
        make \
        g++ \
        tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

# Copy pre-installed node_modules from host
# (quakejs-files is unpublished from npm — cannot run npm ci)
COPY node_modules/ ./node_modules/

# Rebuild native modules (node-pty) for the container's Node.js ABI
RUN npm rebuild node-pty 2>&1 \
    && apt-get purge -y make g++ \
    && apt-get autoremove -y \
    && rm -rf /root/.npm /tmp/*

# Copy application code
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY mock-server.js ./
COPY server.cfg ./
COPY client.html server.html rcon.html ./
COPY build/ ./build/

# Copy public assets and scripts
COPY public/ ./public/
COPY scripts/ ./scripts/

# Copy fresh_quakejs submodule with its node_modules
COPY fresh_quakejs/ ./fresh_quakejs/

# Create directories for data, logs, and secrets
RUN mkdir -p /data /app/logs /run/secrets

# Ports:
#   80    — ssl-manager HTTP reverse proxy (EXPOSE'd by base image)
#   443   — Web server HTTPS (mock-server.js)
#   8080  — Web server HTTP (mock-server.js)
#   9000  — Content server HTTP
#   9001  — Content server HTTPS
#   27950 — Master server WS
#   27951 — Master server WSS
#   27961-27970 — Game server ports (dedicated servers)
#   3478  — STUN
EXPOSE 443 8080 9000 9001 27950 27951 27961-27970 3478

# Health check — verify all critical services are responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD nc -z localhost 27950 && nc -z localhost 8080 && nc -z localhost 9000 || exit 1

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
