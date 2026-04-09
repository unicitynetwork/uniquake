#!/bin/bash
#
# UniQuake Docker Runner
#
# Starts the UniQuake game server in Docker with optional SSL/TLS
# via the ssl-manager base image and HAProxy auto-registration.
#
# Usage:
#   ./start-quake.sh                                      # No SSL, direct ports
#   ./start-quake.sh --domain quake.example.com            # SSL with HAProxy
#   ./start-quake.sh --domain quake.example.com --no-haproxy  # SSL direct
#   ./start-quake.sh --domain quake.example.com --ssl-email admin@example.com
#   ./start-quake.sh --ssl-test-mode --no-haproxy          # Dev mode, self-signed
#   ./start-quake.sh --no-ssl --no-haproxy                 # Plain HTTP, no SSL
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── App identity (set BEFORE sourcing run-lib.sh) ────────────────────────────
CONTAINER_NAME="${CONTAINER_NAME:-uniquake}"
IMAGE_NAME="${UNIQUAKE_IMAGE:-uniquake:latest}"
APP_TITLE="UniQuake Game Server"

# ─── App networking ───────────────────────────────────────────────────────────
APP_NET="${APP_NET:-uniquake-net}"
DATA_VOLUME="${DATA_VOLUME:-uniquake-data}"
HEALTH_PORT=27950                        # Master server WS — first port to come up
SSL_CHECK_PORT=443                       # mock-server.js HTTPS — verify after SSL setup
SSL_HTTPS_PORT="${SSL_HTTPS_PORT:-443}"  # HAProxy SNI passthrough to container's HTTPS
APP_HTTP_PORT="${APP_HTTP_PORT:-8080}"    # Web server exposed via ssl-manager proxy on port 80

# ─── App defaults ─────────────────────────────────────────────────────────────
MASTER_PORT="${MASTER_PORT:-27950}"
CONTENT_PORT="${CONTENT_PORT:-9000}"
WEB_PORT="${WEB_PORT:-8080}"
GAME_SERVER_BASE_PORT="${GAME_SERVER_BASE_PORT:-27961}"

# ─── Source the ssl-manager run library ───────────────────────────────────────
if [ ! -f "${SCRIPT_DIR}/docker/run-lib.sh" ]; then
    echo "ERROR: docker/run-lib.sh not found in ${SCRIPT_DIR}" >&2
    echo "Download it from https://github.com/unicitynetwork/ssl-manager" >&2
    exit 1
fi
source "${SCRIPT_DIR}/docker/run-lib.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# App-specific hooks
# ═══════════════════════════════════════════════════════════════════════════════

app_parse_args() {
    case "$1" in
        --master-port)     require_arg "$1" "${2:-}"; MASTER_PORT="$2";           return 2 ;;
        --content-port)    require_arg "$1" "${2:-}"; CONTENT_PORT="$2";          return 2 ;;
        --web-port)        require_arg "$1" "${2:-}"; WEB_PORT="$2";              return 2 ;;
        --game-base-port)  require_arg "$1" "${2:-}"; GAME_SERVER_BASE_PORT="$2"; return 2 ;;
        --mnemonic)        require_arg "$1" "${2:-}"; UNIQUAKE_MNEMONIC="$2";           return 2 ;;
        --mnemonic-file)   require_arg "$1" "${2:-}"; UNIQUAKE_MNEMONIC_FILE="$2";      return 2 ;;
        --network)         require_arg "$1" "${2:-}"; UNIQUAKE_NETWORK="$2";            return 2 ;;
        --wallet-url)      require_arg "$1" "${2:-}"; UNIQUAKE_WALLET_URL="$2";         return 2 ;;
        --entry-fee)       require_arg "$1" "${2:-}"; UNIQUAKE_ENTRY_FEE="$2";          return 2 ;;
        --payout-nametag)  require_arg "$1" "${2:-}"; UNIQUAKE_DEFAULT_PAYOUT_NAMETAG="$2"; return 2 ;;
        --server-nametag)  require_arg "$1" "${2:-}"; UNIQUAKE_SERVER_NAMETAG="$2";     return 2 ;;
        --nostr-relays)    require_arg "$1" "${2:-}"; UNIQUAKE_NOSTR_RELAYS="$2";       return 2 ;;
        *)                 return 0 ;;
    esac
}

app_validate() {
    validate_port "MASTER_PORT" "$MASTER_PORT"
    validate_port "CONTENT_PORT" "$CONTENT_PORT"
    validate_port "WEB_PORT" "$WEB_PORT"
    validate_port "GAME_SERVER_BASE_PORT" "$GAME_SERVER_BASE_PORT"
    if [ -n "${UNIQUAKE_NETWORK:-}" ] && [ "$UNIQUAKE_NETWORK" != "testnet" ] && [ "$UNIQUAKE_NETWORK" != "mainnet" ]; then
        echo "ERROR: --network must be 'testnet' or 'mainnet'" >&2; exit 1
    fi
}

app_env_args() {
    echo "-e MASTER_PORT=$MASTER_PORT"
    echo "-e CONTENT_PORT=$CONTENT_PORT"
    echo "-e WEB_PORT=$WEB_PORT"
    echo "-e GAME_SERVER_BASE_PORT=$GAME_SERVER_BASE_PORT"
    [ -n "${UNIQUAKE_MNEMONIC:-}" ] && echo "-e UNIQUAKE_MNEMONIC=$UNIQUAKE_MNEMONIC"
    [ -n "${UNIQUAKE_NETWORK:-}" ] && echo "-e UNIQUAKE_NETWORK=$UNIQUAKE_NETWORK"
    [ -n "${UNIQUAKE_DEFAULT_PAYOUT_NAMETAG:-}" ] && echo "-e UNIQUAKE_DEFAULT_PAYOUT_NAMETAG=$UNIQUAKE_DEFAULT_PAYOUT_NAMETAG"
    [ -n "${UNIQUAKE_ENTRY_FEE:-}" ] && echo "-e UNIQUAKE_ENTRY_FEE=$UNIQUAKE_ENTRY_FEE"
    [ -n "${UNIQUAKE_ENTRY_COIN:-}" ] && echo "-e UNIQUAKE_ENTRY_COIN=$UNIQUAKE_ENTRY_COIN"
    [ -n "${UNIQUAKE_WALLET_URL:-}" ] && echo "-e UNIQUAKE_WALLET_URL=$UNIQUAKE_WALLET_URL"
    [ -n "${UNIQUAKE_NOSTR_RELAYS:-}" ] && echo "-e UNIQUAKE_NOSTR_RELAYS=$UNIQUAKE_NOSTR_RELAYS"
    [ -n "${UNIQUAKE_SERVER_NAMETAG:-}" ] && echo "-e UNIQUAKE_SERVER_NAMETAG=$UNIQUAKE_SERVER_NAMETAG"
}

app_port_args() {
    # HTTP/WS ports
    echo "-p ${WEB_PORT}:8080"
    echo "-p ${CONTENT_PORT}:9000"
    echo "-p ${MASTER_PORT}:27950"
    # HTTPS/WSS ports (app handles TLS on port+1)
    echo "-p 443:443"
    echo "-p 9001:9001"
    echo "-p $((MASTER_PORT + 1)):27951"
    # STUN/TURN mapped via app_docker_args (always, both modes)
    # Game server port range
    local i
    for i in $(seq 0 9); do
        local port=$((GAME_SERVER_BASE_PORT + i))
        echo "-p ${port}:$((27961 + i))"
    done
}

app_docker_args() {
    # STUN/TURN must be exposed directly — HAProxy cannot proxy UDP.
    # These ports are always mapped regardless of HAProxy mode.
    echo "-p 3478:3478/udp"
    echo "-p 3478:3478/tcp"

    # Mount mnemonic file as a Docker secret if --mnemonic-file was provided
    if [ -n "${UNIQUAKE_MNEMONIC_FILE:-}" ] && [ -f "${UNIQUAKE_MNEMONIC_FILE}" ]; then
        echo "-v $(realpath "${UNIQUAKE_MNEMONIC_FILE}"):/run/secrets/uniquake_mnemonic:ro"
        echo "-e UNIQUAKE_MNEMONIC_FILE=/run/secrets/uniquake_mnemonic"
    fi

    # Auto-populate HAProxy extra ports for UniQuake protocols.
    # Plain ports use "http" mode (Host header routing).
    # TLS ports use "tcp" mode (SNI passthrough — app handles TLS itself).
    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ] && [ -z "$EXTRA_PORTS" ]; then
        EXTRA_PORTS='[{"listen":27950,"target":27950,"mode":"http"},{"listen":27951,"target":27951,"mode":"tcp"},{"listen":9000,"target":9000,"mode":"http"},{"listen":9001,"target":9001,"mode":"tcp"}]'
        echo "-e EXTRA_PORTS=$EXTRA_PORTS"
    fi
}

app_print_config() {
    echo "  Master:     port $MASTER_PORT (WebSocket)"
    echo "  Content:    port $CONTENT_PORT"
    echo "  Web:        port $WEB_PORT"
    echo "  Game ports: $GAME_SERVER_BASE_PORT-$((GAME_SERVER_BASE_PORT + 9))"
    if [ -n "${UNIQUAKE_MNEMONIC:-}" ] || [ -n "${UNIQUAKE_MNEMONIC_FILE:-}" ]; then
        echo "  Sphere:     ${UNIQUAKE_NETWORK:-testnet}, fee=${UNIQUAKE_ENTRY_FEE:-10} ${UNIQUAKE_ENTRY_COIN:-UCT}"
    fi
}

app_help() {
    cat <<'APPHELP'
UniQuake Configuration:
  --master-port <port>     Master server port (default: 27950)
  --content-port <port>    Content server port (default: 9000)
  --web-port <port>        Web server port (default: 8080)
  --game-base-port <port>  First game server port (default: 27961)

Sphere SDK Configuration:
  --mnemonic <words>       Server wallet mnemonic (12 or 24 words, quoted)
  --mnemonic-file <path>   Path to file containing mnemonic (preferred over --mnemonic)
  --network <net>          Sphere network: 'testnet' or 'mainnet' (default: testnet)
  --wallet-url <url>       Sphere wallet gateway URL
  --entry-fee <amount>     Entry fee per player (default: 10)
  --payout-nametag <tag>   Default payout nametag for unclaimed rewards
  --server-nametag <tag>   Server's Sphere nametag identity
  --nostr-relays <urls>    Comma-separated Nostr relay URLs for DM transport
APPHELP
}

app_health_check() {
    local container="$1"

    # Disable set -e inside health checks — every command is wrapped in
    # if/else and we handle exit codes explicitly. Without this, the
    # process substitution in run-lib.sh inherits set -e and kills the
    # subshell on the first non-zero curl exit code (e.g., HTTP 404).
    set +e

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 1: Internal checks (docker exec — inside the container)
    # ══════════════════════════════════════════════════════════════════════════

    # 1. Master server port
    if docker exec "$container" nc -z localhost "${MASTER_PORT}" 2>/dev/null; then
        echo "pass:Internal: Master server (port ${MASTER_PORT})"
    else
        echo "fail:Internal: Master server not responding (port ${MASTER_PORT})"
    fi

    # 2. Content server port
    local content_resp
    content_resp=$(docker exec "$container" curl -sf -o /dev/null -w '%{http_code}' "http://localhost:${CONTENT_PORT}/" 2>/dev/null)
    if [ "$content_resp" = "200" ] || [ "$content_resp" = "404" ]; then
        echo "pass:Internal: Content server (port ${CONTENT_PORT})"
    else
        echo "warn:Internal: Content server not responding (port ${CONTENT_PORT}, status: ${content_resp:-none})"
    fi

    # 3. Web server — check HTTP port, and HTTPS if SSL domain is set
    #    When SSL is active, port 8080 returns 301 redirect (expected).
    #    The real web server runs on 443 (HTTPS).
    local web_resp
    if [ -n "$SSL_DOMAIN" ]; then
        # SSL mode: HTTP port is a redirect server (301 = correct)
        web_resp=$(docker exec "$container" curl -sf -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null)
        if [ "$web_resp" = "301" ]; then
            echo "pass:Internal: Web HTTP redirect (port ${WEB_PORT} → HTTPS)"
        elif [ "$web_resp" = "200" ]; then
            echo "warn:Internal: Web HTTP on ${WEB_PORT} (expected redirect, got 200 — SSL may not be active)"
        else
            echo "warn:Internal: Web server not responding (port ${WEB_PORT}, status: ${web_resp:-none})"
        fi
        # HTTPS port is the real web server
        local web_https
        web_https=$(docker exec "$container" curl -sf -k -o /dev/null -w '%{http_code}' "https://localhost:443/" 2>/dev/null)
        if [ "$web_https" = "200" ] || [ "$web_https" = "302" ]; then
            echo "pass:Internal: Web HTTPS server (port 443)"
        else
            echo "fail:Internal: Web HTTPS not responding (port 443, status: ${web_https:-none})"
        fi
    else
        web_resp=$(docker exec "$container" curl -sf -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null)
        if [ "$web_resp" = "200" ] || [ "$web_resp" = "302" ]; then
            echo "pass:Internal: Web server (port ${WEB_PORT})"
        else
            echo "warn:Internal: Web server not responding (port ${WEB_PORT}, status: ${web_resp:-none})"
        fi
    fi

    # 4. Asset manifest — content server has indexed game files (with retry)
    local manifest="" asset_count=""
    local attempt
    for attempt in 1 2 3; do
        manifest=$(docker exec "$container" curl -sf "http://localhost:${CONTENT_PORT}/assets/manifest.json" 2>/dev/null)
        if [ -n "$manifest" ]; then
            asset_count=$(echo "$manifest" | jq 'length' 2>/dev/null)
            [ -n "$asset_count" ] && [ "$asset_count" -gt 0 ] 2>/dev/null && break
        fi
        [ "$attempt" -lt 3 ] && sleep 2
    done
    if [ -n "$asset_count" ] && [ "$asset_count" -gt 0 ] 2>/dev/null; then
        echo "pass:Internal: Asset manifest (${asset_count} game files)"
    elif [ -n "$manifest" ]; then
        echo "fail:Internal: Asset manifest empty or invalid"
    else
        echo "fail:Internal: Asset manifest unavailable (/assets/manifest.json)"
    fi

    # 5. Browser engine — ioquake3.js must be loadable (use HTTPS if SSL, else HTTP)
    local engine_url
    if [ -n "$SSL_DOMAIN" ]; then
        engine_url="https://localhost:443/build/ioquake3.js"
    else
        engine_url="http://localhost:${WEB_PORT}/build/ioquake3.js"
    fi
    local engine_resp
    engine_resp=$(docker exec "$container" curl -sf -k -o /dev/null -w '%{http_code}' "$engine_url" 2>/dev/null)
    if [ "$engine_resp" = "200" ]; then
        echo "pass:Internal: Browser engine (ioquake3.js)"
    else
        echo "fail:Internal: Browser engine not loadable (status: ${engine_resp:-none})"
    fi

    # 6. Game page renders (use HTTPS if SSL, else HTTP)
    local quake_url
    if [ -n "$SSL_DOMAIN" ]; then
        quake_url="https://localhost:443/quake"
    else
        quake_url="http://localhost:${WEB_PORT}/quake"
    fi
    local quake_resp
    quake_resp=$(docker exec "$container" curl -sf -k -o /dev/null -w '%{http_code}' "$quake_url" 2>/dev/null)
    if [ "$quake_resp" = "200" ]; then
        echo "pass:Internal: Game page (/quake)"
    else
        echo "fail:Internal: Game page not rendering (status: ${quake_resp:-none})"
    fi

    # 7. WebSocket handshake + default game session
    #    Connects to master, checks for running sessions.
    #    If none running, starts a default game and waits for it to appear.
    #    Uses a single Node.js script that handles the full lifecycle.
    local gs_result=""
    gs_result=$(docker exec "$container" timeout 60 node -e "
        const WebSocket = require('ws');
        const ws = new WebSocket('ws://localhost:${MASTER_PORT}');
        let phase = 'connecting';

        const die = (code, msg) => { console.log(msg); ws.close(); setTimeout(() => process.exit(code), 100); };
        const failTimer = setTimeout(() => die(1, 'fail:Timed out waiting for game session'), 55000);

        ws.on('error', (e) => die(1, 'fail:WebSocket error: ' + e.message));

        ws.on('open', () => {
            phase = 'listing';
            ws.send(JSON.stringify({ type: 'list_servers' }));
        });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch(e) { return; }

            if (msg.type === 'server_list' && phase === 'listing') {
                const count = (msg.servers || []).length;
                if (count > 0) {
                    clearTimeout(failTimer);
                    die(0, 'pass:Game session active (' + count + ' server(s))');
                    return;
                }
                // No sessions — start a default game (unicity: true required for game management)
                console.log('wait:No game sessions, starting default game...');
                phase = 'starting';
                ws.send(JSON.stringify({
                    unicity: true,
                    type: 'start_game_server',
                    serverInfo: {
                        name: 'UniQuake Default',
                        map: 'q3dm17',
                        game: 'baseq3',
                        maxPlayers: 8
                    }
                }));
            }

            // After starting, poll for the session to appear
            if (phase === 'starting') {
                if (msg.type === 'game_server_started' || msg.type === 'server_list') {
                    if (msg.type === 'server_list') {
                        const c = (msg.servers || []).length;
                        if (c > 0) {
                            clearTimeout(failTimer);
                            die(0, 'pass:Default game session started (' + c + ' server(s))');
                            return;
                        }
                    }
                    if (msg.type === 'game_server_started') {
                        // Server is starting, poll for it in the list
                        phase = 'waiting';
                        console.log('wait:Game server spawned, waiting for registration...');
                    }
                }
                if (msg.type === 'error') {
                    clearTimeout(failTimer);
                    die(1, 'fail:Could not start game: ' + (msg.error || 'unknown'));
                    return;
                }
            }

            if (phase === 'waiting') {
                if (msg.type === 'server_list') {
                    const c = (msg.servers || []).length;
                    if (c > 0) {
                        clearTimeout(failTimer);
                        die(0, 'pass:Default game session started (' + c + ' server(s))');
                        return;
                    }
                }
            }
        });

        // Poll server list periodically while waiting
        const pollInterval = setInterval(() => {
            if (ws.readyState === 1 && (phase === 'starting' || phase === 'waiting')) {
                ws.send(JSON.stringify({ type: 'list_servers' }));
            }
        }, 3000);

        ws.on('close', () => clearInterval(pollInterval));
    " 2>/dev/null | while IFS= read -r line; do
        # Stream progress lines (wait:...) to stderr for real-time feedback
        local prefix="${line%%:*}"
        if [ "$prefix" = "wait" ]; then
            printf "\r\033[K  ... %s" "${line#*:}" >&2
        else
            printf "\r\033[K" >&2
            echo "$line"
        fi
    done)

    if [ -n "$gs_result" ]; then
        echo "$gs_result"
    else
        echo "fail:Internal: Game session check — no response from master"
    fi

    # ── Sphere payment system status ─────────────────────────────────────────

    # 8. Sphere wallet status (if mnemonic configured)
    if [ -n "${UNIQUAKE_MNEMONIC:-}" ] || [ -n "${UNIQUAKE_MNEMONIC_FILE:-}" ]; then
        local sphere_status
        sphere_status=$(docker exec "$container" timeout 5 node -e "
            const logs = require('fs').readFileSync('/proc/1/fd/1', 'utf8').split('\\n');
            const sphereInit = logs.find(l => l.includes('Sphere payment system initialized') || l.includes('[PaymentManager] Initialized'));
            const sphereFail = logs.find(l => l.includes('Sphere payment system failed') || l.includes('payment features disabled'));
            if (sphereInit) { console.log('pass:' + sphereInit.trim()); }
            else if (sphereFail) { console.log('warn:' + sphereFail.trim()); }
            else { console.log('warn:Sphere wallet status unknown'); }
        " 2>/dev/null | tail -1)
        if [ -n "$sphere_status" ]; then
            local sphere_level="${sphere_status%%:*}"
            local sphere_msg="${sphere_status#*:}"
            echo "${sphere_level}:Internal: Sphere wallet — ${sphere_msg}"
        else
            echo "warn:Internal: Sphere wallet status — could not determine"
        fi
    fi

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 2: External reachability (from host — tests HAProxy / port publish)
    # ══════════════════════════════════════════════════════════════════════════

    # Determine the external target: domain name or localhost
    local ext_host="${SSL_DOMAIN:-localhost}"

    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ]; then
        # ── HAProxy mode: test through HAProxy ───────────────────────────────

        # 8. HAProxy port check — verify required ports are published
        local missing_ports=""
        for p in ${MASTER_PORT} $((MASTER_PORT + 1)) ${CONTENT_PORT} $((CONTENT_PORT + 1)); do
            if ! docker port haproxy "$p/tcp" >/dev/null 2>&1; then
                missing_ports="${missing_ports} ${p}"
            fi
        done
        if [ -z "$missing_ports" ]; then
            echo "pass:External: HAProxy has all required ports published"
        else
            echo "fail:External: HAProxy missing host port bindings:${missing_ports}"
            echo "fail:External: Restart HAProxy with additional -p flags for each missing port"
            echo "fail:External: e.g.: docker stop haproxy && docker rm haproxy && docker run ... $(for mp in $missing_ports; do printf -- '-p %s:%s ' "$mp" "$mp"; done)..."
        fi

        # 9. Game page via HTTPS (port 443 through HAProxy)
        if [ -n "$SSL_DOMAIN" ]; then
            local ext_quake
            ext_quake=$(curl -sf --max-time 5 -o /dev/null -w '%{http_code}' -k "https://${ext_host}/quake" 2>/dev/null)
            if [ "$ext_quake" = "200" ]; then
                echo "pass:External: Game page https://${ext_host}/quake"
            else
                echo "fail:External: Game page not reachable via HTTPS (status: ${ext_quake:-none})"
            fi
        fi

        # 10. Content manifest via HAProxy (port 9000 — plain HTTP)
        local ext_manifest
        ext_manifest=$(curl -sf --max-time 5 "http://${ext_host}:${CONTENT_PORT}/assets/manifest.json" 2>/dev/null)
        if [ -n "$ext_manifest" ]; then
            local ext_count
            ext_count=$(echo "$ext_manifest" | jq 'length' 2>/dev/null)
            if [ -n "$ext_count" ] && [ "$ext_count" -gt 0 ] 2>/dev/null; then
                echo "pass:External: Content manifest via :${CONTENT_PORT} (${ext_count} files)"
            else
                echo "fail:External: Content manifest via :${CONTENT_PORT} — empty"
            fi
        else
            echo "fail:External: Content not reachable at ${ext_host}:${CONTENT_PORT} (HAProxy port not published?)"
        fi

        # 11. Content manifest via HTTPS (port 9001 — TLS passthrough)
        if [ -n "$SSL_DOMAIN" ]; then
            local ext_manifest_tls
            ext_manifest_tls=$(curl -sf --max-time 5 -k "https://${ext_host}:$((CONTENT_PORT + 1))/assets/manifest.json" 2>/dev/null)
            if [ -n "$ext_manifest_tls" ]; then
                local ext_tls_count
                ext_tls_count=$(echo "$ext_manifest_tls" | jq 'length' 2>/dev/null)
                if [ -n "$ext_tls_count" ] && [ "$ext_tls_count" -gt 0 ] 2>/dev/null; then
                    echo "pass:External: Content manifest via :$((CONTENT_PORT + 1)) TLS (${ext_tls_count} files)"
                else
                    echo "fail:External: Content manifest via :$((CONTENT_PORT + 1)) TLS — empty"
                fi
            else
                echo "fail:External: Content not reachable at ${ext_host}:$((CONTENT_PORT + 1)) (TLS port not published?)"
            fi
        fi

        # 12. Master server WebSocket via HAProxy (port 27950 — plain WS)
        if command -v node >/dev/null 2>&1 && [ -d "${SCRIPT_DIR}/node_modules/ws" ] 2>/dev/null; then
            local ext_ws
            ext_ws=$(NODE_PATH="${SCRIPT_DIR}/node_modules" timeout 5 node -e "
                const WebSocket = require('ws');
                const ws = new WebSocket('ws://${ext_host}:${MASTER_PORT}');
                const timer = setTimeout(() => { console.log('timeout'); process.exit(1); }, 4000);
                ws.on('open', () => {
                    ws.send(JSON.stringify({ type: 'list_servers' }));
                });
                ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === 'server_list') {
                            console.log('ok:' + (msg.servers || []).length);
                            clearTimeout(timer);
                            ws.close();
                        }
                    } catch(e) {}
                });
                ws.on('error', (e) => { console.log('error:' + e.message); process.exit(1); });
            " 2>/dev/null | tail -1)
            if [ -n "$ext_ws" ] && [ "${ext_ws%%:*}" = "ok" ]; then
                echo "pass:External: WebSocket via :${MASTER_PORT} (${ext_ws#*:} sessions)"
            else
                echo "fail:External: WebSocket not reachable at ${ext_host}:${MASTER_PORT} (${ext_ws:-no response})"
            fi
        else
            # Fallback: just TCP check
            if nc -z -w3 "$ext_host" "$MASTER_PORT" 2>/dev/null; then
                echo "pass:External: Master port ${MASTER_PORT} reachable (TCP)"
            else
                echo "fail:External: Master port ${MASTER_PORT} not reachable"
            fi
        fi

    else
        # ── Direct mode: test published ports on localhost ────────────────────

        # 8. Game page
        local ext_quake
        ext_quake=$(curl -sf --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/quake" 2>/dev/null)
        if [ "$ext_quake" = "200" ]; then
            echo "pass:External: Game page http://localhost:${WEB_PORT}/quake"
        else
            echo "fail:External: Game page not reachable (status: ${ext_quake:-none})"
        fi

        # 9. Content manifest
        local ext_manifest
        ext_manifest=$(curl -sf --max-time 5 "http://localhost:${CONTENT_PORT}/assets/manifest.json" 2>/dev/null)
        if [ -n "$ext_manifest" ]; then
            local ext_count
            ext_count=$(echo "$ext_manifest" | jq 'length' 2>/dev/null)
            if [ -n "$ext_count" ] && [ "$ext_count" -gt 0 ] 2>/dev/null; then
                echo "pass:External: Content manifest (${ext_count} game files)"
            else
                echo "fail:External: Content manifest empty"
            fi
        else
            echo "fail:External: Content not reachable at localhost:${CONTENT_PORT}"
        fi

        # 10. Master WS
        if nc -z -w3 localhost "$MASTER_PORT" 2>/dev/null; then
            echo "pass:External: Master port ${MASTER_PORT} reachable"
        else
            echo "fail:External: Master port ${MASTER_PORT} not reachable"
        fi
    fi

    # Restore set -e (defensive — function runs in process substitution subshell,
    # but this protects against future refactoring that calls it directly)
    set -e
}

app_summary() {
    echo ""
    echo "Endpoints:"
    if [ "$USE_HAPROXY" = true ] && [ -n "$HAPROXY_HOST" ] && [ -n "$SSL_DOMAIN" ]; then
        echo "  Game:    https://$SSL_DOMAIN/quake"
        echo "  Master:  wss://$SSL_DOMAIN:27951 (TLS passthrough)"
        echo "  Master:  ws://$SSL_DOMAIN:27950  (plain)"
        echo "  Content: https://$SSL_DOMAIN:9001 (TLS passthrough)"
        echo "  Content: http://$SSL_DOMAIN:9000  (plain)"
    else
        echo "  Game:    http://localhost:$WEB_PORT/quake"
        echo "  Master:  ws://localhost:$MASTER_PORT"
        echo "  Content: http://localhost:$CONTENT_PORT"
    fi
    echo ""
    if [ -n "${UNIQUAKE_MNEMONIC:-}" ] || [ -n "${UNIQUAKE_MNEMONIC_FILE:-}" ]; then
        echo "  Sphere:  enabled (${UNIQUAKE_NETWORK:-testnet})"
    else
        echo "  Sphere:  disabled (no mnemonic — legacy mode)"
    fi
    echo ""
    echo "  Server CLI: docker exec -it \"$CONTAINER_NAME\" node bin/server-cli.js"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Run
# ═══════════════════════════════════════════════════════════════════════════════
ssl_manager_run "$@"
