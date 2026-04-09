#!/bin/bash
# UniQuake Docker entrypoint
# Follows ssl-manager pattern: ssl-setup -> config -> start services

# Do NOT use set -e — background process management requires explicit error handling
set -uo pipefail

# Global variables for process management
MASTER_PID=""
CONTENT_PID=""
WEB_PID=""
SHUTDOWN_REQUESTED=0
EXIT_CODE=1

# ---------------------------------------------------------------------------
# Signal handler for graceful shutdown
# ---------------------------------------------------------------------------
handle_signal() {
    # Guard against re-entrancy (e.g., signal during stop_services)
    [ "$SHUTDOWN_REQUESTED" -eq 1 ] && return

    local signal=$1
    echo "[entrypoint] Received $signal signal, initiating graceful shutdown..."
    SHUTDOWN_REQUESTED=1

    # Deregister from HAProxy if we were registered (with timeout to prevent hang)
    if [ -n "${SSL_DOMAIN:-}" ] && [ -n "${HAPROXY_HOST:-}" ]; then
        echo "[entrypoint] Deregistering from HAProxy..."
        timeout 5 haproxy-register unregister 2>/dev/null || true
    fi

    # Stop the HTTP reverse proxy (ssl-manager)
    if [ -f /tmp/.ssl-http-proxy.pid ]; then
        local proxy_pid
        proxy_pid=$(cat /tmp/.ssl-http-proxy.pid 2>/dev/null || true)
        if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
            kill "$proxy_pid" 2>/dev/null || true
        fi
    fi

    # Stop the renewal loop
    if [ -f /tmp/.ssl-renew.pid ]; then
        local renew_pid
        renew_pid=$(cat /tmp/.ssl-renew.pid 2>/dev/null || true)
        if [ -n "$renew_pid" ] && kill -0 "$renew_pid" 2>/dev/null; then
            kill "$renew_pid" 2>/dev/null || true
        fi
    fi

    # Forward signal to application processes
    for pid_var in MASTER_PID CONTENT_PID WEB_PID; do
        local pid="${!pid_var}"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "[entrypoint] Stopping $pid_var (PID $pid)..."
            kill -"$signal" "$pid" 2>/dev/null || true
        fi
    done

    # Wait for processes to exit gracefully (up to 15 seconds)
    local wait_count=0
    while [ $wait_count -lt 15 ]; do
        local any_running=false
        for pid_var in MASTER_PID CONTENT_PID WEB_PID; do
            local pid="${!pid_var}"
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                any_running=true
                break
            fi
        done
        [ "$any_running" = false ] && break
        sleep 1
        wait_count=$((wait_count + 1))
    done

    # Force-kill any remaining processes
    for pid_var in MASTER_PID CONTENT_PID WEB_PID; do
        local pid="${!pid_var}"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "[entrypoint] Force-killing $pid_var (PID $pid)..."
            kill -9 "$pid" 2>/dev/null || true
        fi
    done

    # Reap zombies to release PIDs
    wait 2>/dev/null || true

    echo "[entrypoint] Graceful shutdown complete"
    exit 0
}

# Set up signal handlers (SIGHUP mapped to TERM — raw HUP kills Node.js without graceful shutdown)
trap 'handle_signal TERM' SIGTERM SIGHUP
trap 'handle_signal INT' SIGINT

# ---------------------------------------------------------------------------
# Generate UniQuake configuration from environment
# ---------------------------------------------------------------------------
generate_config() {
    echo "[entrypoint] Generating UniQuake configuration..."

    # Set HOST_IP from SSL_DOMAIN if available, otherwise use environment or default
    if [ -n "${SSL_DOMAIN:-}" ]; then
        export HOST_IP="${SSL_DOMAIN}"
    fi
    export HOST_IP="${HOST_IP:-localhost}"

    # Port configuration
    export MASTER_PORT="${MASTER_PORT:-27950}"
    export CONTENT_PORT="${CONTENT_PORT:-9000}"
    export WEB_PORT="${WEB_PORT:-8080}"
    export GAME_SERVER_IP="${GAME_SERVER_IP:-${HOST_IP}}"
    export GAME_SERVER_BASE_PORT="${GAME_SERVER_BASE_PORT:-27961}"

    # Sphere SDK configuration
    export UNIQUAKE_NETWORK="${UNIQUAKE_NETWORK:-testnet}"
    export UNIQUAKE_DEFAULT_PAYOUT_NAMETAG="${UNIQUAKE_DEFAULT_PAYOUT_NAMETAG:-babaika10}"
    export UNIQUAKE_ENTRY_FEE="${UNIQUAKE_ENTRY_FEE:-10}"
    export UNIQUAKE_ENTRY_COIN="${UNIQUAKE_ENTRY_COIN:-UCT}"
    export UNIQUAKE_WALLET_URL="${UNIQUAKE_WALLET_URL:-https://sphere.unicity.network}"
    export UNIQUAKE_NOSTR_RELAYS="${UNIQUAKE_NOSTR_RELAYS:-wss://nostr-relay.testnet.unicity.network}"

    # Mnemonic source detection (S3 — never log the mnemonic itself!)
    if [ -f "/run/secrets/uniquake_mnemonic" ] && [ -z "${UNIQUAKE_MNEMONIC_FILE:-}" ]; then
        export UNIQUAKE_MNEMONIC_FILE="/run/secrets/uniquake_mnemonic"
    fi
    if [ -n "${UNIQUAKE_MNEMONIC_FILE:-}" ]; then
        if [ -f "${UNIQUAKE_MNEMONIC_FILE}" ]; then
            echo "[entrypoint] Sphere wallet: mnemonic loaded from file"
        else
            echo "[entrypoint] WARNING: UNIQUAKE_MNEMONIC_FILE set but not found: ${UNIQUAKE_MNEMONIC_FILE}"
        fi
    elif [ -n "${UNIQUAKE_MNEMONIC:-}" ]; then
        echo "[entrypoint] Sphere wallet: mnemonic from env (consider UNIQUAKE_MNEMONIC_FILE for security)"
    else
        echo "[entrypoint] WARNING: No Sphere mnemonic — payment features disabled"
    fi

    # When SSL certs are available (from ssl-manager), let the app create its own
    # TLS listeners on the "+1" ports (27951, 9001, 443) — same as bare-metal.
    # HAProxy does TLS passthrough (SNI routing) to these ports.
    #
    # mock-server.js port allocation:
    #   - HTTP on port 80 is BLOCKED (ssl-manager's HTTP proxy owns it)
    #   - HTTPS on port 443 is OK (ssl-manager only uses port 80)
    #   - We set HTTP_PORT so the HTTP fallback uses 8080 instead of 80
    export HTTP_PORT="${WEB_PORT}"

    if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
        export SSL_CERT_PATH="${SSL_CERT_FILE}"
        export SSL_KEY_PATH="${SSL_KEY_FILE}"
        # Let config.js detect these certs and enable TLS listeners
        echo "[entrypoint] SSL enabled: app will create TLS listeners (27951, 9001, 443)"
    fi

    # Generate config files via Node.js
    cd /app
    if ! node bin/generate-configs.js; then
        echo "[entrypoint] ERROR: Failed to generate configuration"
        return 1
    fi
    echo "[entrypoint] Configuration generated for host: ${HOST_IP}"
}

# ---------------------------------------------------------------------------
# Start all application processes
# ---------------------------------------------------------------------------
start_services() {
    cd /app

    echo "[entrypoint] Starting content server on port ${CONTENT_PORT:-9000}..."
    node bin/content.js --config ./content-config.json &
    CONTENT_PID=$!
    echo "[entrypoint] Content server started (PID $CONTENT_PID)"

    echo "[entrypoint] Starting web server on port ${WEB_PORT:-8080}..."
    node mock-server.js &
    WEB_PID=$!
    echo "[entrypoint] Web server started (PID $WEB_PID)"

    echo "[entrypoint] Starting combined master server on port ${MASTER_PORT:-27950}..."
    node bin/combined-master.js --config ./master-config.json &
    MASTER_PID=$!
    echo "[entrypoint] Combined master server started (PID $MASTER_PID)"

    echo "[entrypoint] All UniQuake services started"
    echo "[entrypoint]   Master:  port ${MASTER_PORT:-27950} (WebSocket)"
    echo "[entrypoint]   Content: port ${CONTENT_PORT:-9000}"
    echo "[entrypoint]   Web:     port ${WEB_PORT:-8080}"
    if [ -n "${SSL_DOMAIN:-}" ]; then
        echo "[entrypoint]   SSL:     ${SSL_DOMAIN}"
    fi
    if [ -n "${UNIQUAKE_MNEMONIC:-}" ] || [ -n "${UNIQUAKE_MNEMONIC_FILE:-}" ]; then
        echo "[entrypoint]   Sphere:  network=${UNIQUAKE_NETWORK}, fee=${UNIQUAKE_ENTRY_FEE} ${UNIQUAKE_ENTRY_COIN}"
    fi
}

# ---------------------------------------------------------------------------
# Stop all application processes
# ---------------------------------------------------------------------------
stop_services() {
    # Block signals during stop to prevent re-entrancy
    trap '' SIGTERM SIGINT SIGHUP

    for pid_var in MASTER_PID CONTENT_PID WEB_PID; do
        local pid="${!pid_var}"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done

    # Wait briefly then force-kill
    sleep 2

    for pid_var in MASTER_PID CONTENT_PID WEB_PID; do
        local pid="${!pid_var}"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done

    # Reap zombies to prevent PID reuse issues
    wait 2>/dev/null || true

    MASTER_PID=""
    CONTENT_PID=""
    WEB_PID=""

    # Restore signal handlers
    trap 'handle_signal TERM' SIGTERM SIGHUP
    trap 'handle_signal INT' SIGINT
}

# ===========================================================================
# Main execution
# ===========================================================================

# Step 1: Run ssl-setup from ssl-manager base image
echo "[entrypoint] Running ssl-setup..."
ssl_setup_exit=0
/usr/local/bin/ssl-setup || ssl_setup_exit=$?

# Check if ssl-setup was killed by a signal (container stopping during startup)
if [ "$ssl_setup_exit" -gt 128 ]; then
    exit "$ssl_setup_exit"
fi

if [ "$ssl_setup_exit" -ne 0 ]; then
    if [ "${SSL_REQUIRED:-true}" = "true" ]; then
        echo "[entrypoint] ERROR: ssl-setup failed (exit code $ssl_setup_exit) and SSL_REQUIRED=true"
        echo "[entrypoint] Set SSL_REQUIRED=false to allow non-SSL fallback."
        exit "$ssl_setup_exit"
    else
        echo "[entrypoint] WARNING: ssl-setup failed (exit code $ssl_setup_exit) but SSL_REQUIRED=false"
        echo "[entrypoint] Continuing without SSL"
    fi
fi

# Step 2: Source SSL environment if ssl-setup wrote it
if [ -f /tmp/.ssl-env ]; then
    # Validate file contains only expected variable assignments before sourcing
    if grep -qE '^SSL_(CERT|KEY)_FILE=' /tmp/.ssl-env; then
        . /tmp/.ssl-env
        echo "[entrypoint] SSL configured: cert=${SSL_CERT_FILE:-}, key=${SSL_KEY_FILE:-}"

        if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
            local_expiry=$(openssl x509 -enddate -noout -in "${SSL_CERT_FILE}" 2>/dev/null | cut -d= -f2) || true
            if [ -n "$local_expiry" ]; then
                echo "[entrypoint] SSL certificate expires: ${local_expiry}"
            else
                echo "[entrypoint] WARNING: Could not read SSL certificate expiry"
            fi
        fi

        if [ "${SSL_TEST_MODE:-}" = "true" ]; then
            echo "[entrypoint] WARNING: SSL_TEST_MODE active — self-signed certificate"
        fi
    else
        echo "[entrypoint] WARNING: /tmp/.ssl-env has unexpected contents, skipping"
    fi
else
    echo "[entrypoint] No SSL certificates — running in plain HTTP/WS mode"
fi

# Step 3: Generate UniQuake configuration
if ! generate_config; then
    exit 1
fi

# Step 4: Start UniQuake services
start_services

# Step 5: Supervisor loop — monitors ALL processes and handles SSL renewal
while [ "$SHUTDOWN_REQUESTED" -eq 0 ]; do
    # Check for SSL certificate renewal restart marker
    if [ -f /tmp/.ssl-renewal-restart ]; then
        rm -f /tmp/.ssl-renewal-restart
        echo "[entrypoint] SSL certificate renewed — restarting services to load new cert"

        # Re-source SSL env for updated cert paths
        if [ -f /tmp/.ssl-env ] && grep -qE '^SSL_(CERT|KEY)_FILE=' /tmp/.ssl-env; then
            . /tmp/.ssl-env
        fi

        # Regenerate config and restart services
        generate_config || echo "[entrypoint] WARNING: config regeneration failed, restarting with previous config"
        stop_services
        # If shutdown was requested during stop_services, don't start new processes
        [ "$SHUTDOWN_REQUESTED" -eq 1 ] && break
        start_services
        continue
    fi

    # Check if ANY critical process has exited
    for check_pid_var in MASTER_PID CONTENT_PID WEB_PID; do
        check_pid="${!check_pid_var}"
        if [ -n "$check_pid" ] && ! kill -0 "$check_pid" 2>/dev/null; then
            # wait may fail if tini already reaped the zombie (exit 127)
            wait "$check_pid" 2>/dev/null
            wait_rc=$?
            EXIT_CODE=$([ "$wait_rc" -eq 127 ] && echo 1 || echo "$wait_rc")
            echo "[entrypoint] $check_pid_var exited unexpectedly (code $EXIT_CODE)"
            SHUTDOWN_REQUESTED=1
            break
        fi
    done

    [ "$SHUTDOWN_REQUESTED" -eq 1 ] && break

    # Sleep briefly before next check
    sleep 5
done

# Clean up remaining processes (app + ssl-manager)
for pid in "$CONTENT_PID" "$WEB_PID" "$MASTER_PID"; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
    fi
done

# Clean up ssl-manager background processes
for pidfile in /tmp/.ssl-http-proxy.pid /tmp/.ssl-renew.pid; do
    if [ -f "$pidfile" ]; then
        ssl_pid=$(cat "$pidfile" 2>/dev/null || true)
        if [ -n "$ssl_pid" ] && kill -0 "$ssl_pid" 2>/dev/null; then
            kill "$ssl_pid" 2>/dev/null || true
        fi
    fi
done

wait 2>/dev/null || true

exit "$EXIT_CODE"
