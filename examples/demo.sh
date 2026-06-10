#!/usr/bin/env bash
# Reflex MVP acceptance walk: daemon + CLI + examples against local NATS.
# Requires: nats-server -js on 127.0.0.1:4222 (the daemon fail-fasts otherwise).
set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_DIR="$(mktemp -d)"
trap 'kill "${DAEMON_PID:-0}" 2>/dev/null || true; rm -rf "$DEMO_DIR"' EXIT

# Env contract (see docs/plan-mvp-execution.md): principal/stack identify the
# operator on the bus; the config file points at the examples as a watch root.
cat > "$DEMO_DIR/config.yaml" <<EOF
principal: jc
stack: demo
watch_roots: ["$(pwd)/examples"]
activations_dir: "$DEMO_DIR/activations"
EOF
export REFLEX_NATS_URL="nats://127.0.0.1:4222"
export REFLEX_NATS_INSECURE=1   # local dev bus is unauthenticated (DD-72 creds not yet provisioned)
export XDG_STATE_HOME="$DEMO_DIR/state"

echo "=== starting reflex-daemon (examples as watch root) ==="
REFLEX_CONFIG="$DEMO_DIR/config.yaml" bun -e "
import { loadConfig } from './src/config/load';
import { startDaemon } from './src/daemon';
const cfg = loadConfig({ configPath: '$DEMO_DIR/config.yaml' });
const daemon = await startDaemon(cfg, { httpPort: 0 });
process.on('SIGTERM', () => void daemon.stop().then(() => process.exit(0)));
" &
DAEMON_PID=$!
sleep 2

run_cli() {
  bun -e "
import { loadConfig } from './src/config/load';
import { runCommand } from './src/cli/main';
const cfg = loadConfig({ configPath: '$DEMO_DIR/config.yaml' });
const r = await runCommand(process.argv.slice(1), { cfg });
if (r.stdout) console.log(r.stdout);
if (r.stderr) console.error(r.stderr);
process.exit(r.exitCode);
" "$@"
}

echo; echo "=== reflex status ==="
run_cli status
echo; echo "=== reflex fire f-testing ==="
run_cli fire f-testing --input '{"suite":"smoke"}'
echo; echo "=== reflex pending (Matched Decisions awaiting approval) ==="
run_cli pending
echo; echo "=== reflex history ==="
run_cli history --limit 5
echo; echo "=== stopping daemon ==="
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
echo "demo complete — re-run to see cooldown/guard behavior as honest Blocked entries"
