#!/bin/zsh
# opencode-env-probe.sh — what a spawned `opencode serve` actually loads, and what (if anything)
# can pin it. The measurement behind ../../FINDINGS.md, "the OpenCode side of the environment
# decision".
#
# WHY THIS EXISTS
#
# The Claude Code half of the environment decision shipped with `--setting-sources=project
# --strict-mcp-config`. Two of three reviewers then declined to call the OpenCode adapter's lack of
# pinning a defect, explicitly because nobody had measured whether `opencode` has an equivalent.
# This closes that. A third model (`big-pickle`) was asked to decide and reported that
# `OPENCODE_CONFIG=<file>` was "the only real pin, verified to override the base keys" — this probe
# is what showed that it changes nothing, which is why the result is checked in rather than trusted.
#
# THIS PROBE IS FREE. No model call, no tokens: it starts a real `opencode serve`, reads the
# server's own `GET /config` and `GET /agent`, and kills it. No session is ever prompted.
#
# Each row runs in a FRESH EMPTY directory, so anything it reports came from global config rather
# than from a project. Run:  ./opencode-env-probe.sh
# Captured runs: ./evidence/12-opencode-env-matrix.txt

set -u
PORT_BASE=${PORT_BASE:-39300}
i=0

probe() {
  local label="$1"; shift
  local port=$((PORT_BASE + i)); i=$((i + 1))
  local d; d=$(mktemp -d "$HOME/ctd-oc-probe-XXXXXX")
  ( cd "$d" && env "$@" opencode serve --port "$port" --hostname 127.0.0.1 >"/tmp/oc-$port.log" 2>&1 & )
  local n=0
  while [ $n -lt 40 ]; do
    curl -s -m 2 "http://127.0.0.1:$port/config" >/dev/null 2>&1 && break
    sleep 0.5; n=$((n + 1))
  done
  curl -s -m 8 "http://127.0.0.1:$port/config" >"/tmp/oc-cfg-$port.json" 2>/dev/null
  curl -s -m 8 "http://127.0.0.1:$port/agent"  >"/tmp/oc-ag-$port.json"  2>/dev/null
  printf '%-58s ' "$label"
  # `strict=False`: the real /config embeds prompt templates containing raw newlines, which strict
  # JSON rejects. An earlier version of this probe reported "config unparsable" for every row
  # because of that, which looks exactly like "the server did not start".
  python3 - "$port" <<'PY'
import json,sys
port=sys.argv[1]
try:
    cfg=json.loads(open(f'/tmp/oc-cfg-{port}.json').read(),strict=False)
except Exception as e:
    print('UNREADABLE', e); raise SystemExit
mcp=cfg.get('mcp') or {}
try:
    ag=json.loads(open(f'/tmp/oc-ag-{port}.json').read(),strict=False)
    nag=len(ag)
except Exception:
    nag='?'
print('mcp=%-2d agents_in_config=%-3d plugins=%-2d /agent=%-3s %s'
      % (len(mcp), len(cfg.get('agent') or {}), len(cfg.get('plugin') or []), nag, sorted(mcp)[:8]))
PY
  pkill -9 -f "opencode serve --port $port" 2>/dev/null
  rm -rf "$d"
}

EMPTY=$(mktemp -d "$HOME/ctd-oc-emptycfg-XXXXXX")
printf '{}'                                  > /tmp/oc-probe-empty.json
printf '{"mcp":{},"agent":{},"plugin":[]}'   > /tmp/oc-probe-stripped.json

echo "opencode $(opencode --version 2>/dev/null | tail -1)"
echo "each row: a FRESH EMPTY cwd, so anything shown came from global config"
echo ""
probe "(nothing -- today's behaviour)"                  PROBE_NOOP=1
probe "OPENCODE_DISABLE_PROJECT_CONFIG=1"               OPENCODE_DISABLE_PROJECT_CONFIG=1
probe "OPENCODE_CONFIG={}"                              OPENCODE_CONFIG=/tmp/oc-probe-empty.json
probe "OPENCODE_CONFIG={mcp:{},agent:{},plugin:[]}"     OPENCODE_CONFIG=/tmp/oc-probe-stripped.json
probe "OPENCODE_CONFIG_CONTENT={}"                      OPENCODE_CONFIG_CONTENT='{}'
probe "OPENCODE_CONFIG_DIR=<empty>"                     OPENCODE_CONFIG_DIR="$EMPTY"
probe "OPENCODE_PURE=1"                                 OPENCODE_PURE=1
probe "DISABLE_DEFAULT_PLUGINS + EXTERNAL_SKILLS"       OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1
probe "XDG_CONFIG_HOME=<empty>   <-- the only lever"    XDG_CONFIG_HOME="$EMPTY"
probe "XDG_CONFIG_HOME=<empty>   (re-verify)"           XDG_CONFIG_HOME="$EMPTY"

# The row that matters if a pin is ever added. An EMPTY config dir drops the MCP servers AND the
# model-agent roster (luna / sol / terra / opus and the rest of the Bedrock line-up), which this
# project REQUIRES for cross-model review and sometimes for coding. A CURATED dir -- the global
# config's `agent`, `provider` and `model` keys, with `mcp`, `plugin` and `skills` omitted -- keeps
# the roster and still drops every MCP server. That is the only shape a future pin may take.
CURATED=$(mktemp -d "$HOME/ctd-oc-curated-XXXXXX")
mkdir -p "$CURATED/opencode"
python3 - "$CURATED/opencode/opencode.json" <<'PY2'
import json, os, sys
src = os.path.expanduser('~/.config/opencode/opencode.json')
try:
    d = json.load(open(src), strict=False)
except Exception:
    d = {}
# Carry ONLY what the roster needs. `provider` is load-bearing: it is what registers the
# amazon-bedrock model IDs the agents point at, so keeping `agent` without it yields a roster
# of aliases to models the server does not know.
json.dump({k: d[k] for k in ('$schema', 'agent', 'provider', 'model') if k in d}, open(sys.argv[1], 'w'))
PY2
probe "XDG_CONFIG_HOME=<curated: agent+provider, no mcp>" XDG_CONFIG_HOME="$CURATED"

rm -rf "$EMPTY" "$CURATED"
echo ""
echo "REQUIREMENT: luna / sol / terra / opus and the other amazon-bedrock agents must ALWAYS be"
echo "reachable through this adapter (cross-model review, and sometimes coding). An EMPTY config"
echo "dir removes them; the CURATED row above keeps all 13 while still reporting mcp=0. If a pin"
echo "is ever added, it takes the curated shape -- never the empty one."
echo ""
echo "Auth is NOT under XDG_CONFIG_HOME -- it lives in ~/.local/share/opencode/auth.json"
echo "(XDG_DATA_HOME), so pinning config this way does not break credentials. What it DOES"
echo "remove is the model-agent roster (luna/sol/terra/opus) defined in the global config."
echo ""
echo "leftover probe servers (expect 0): $(pgrep -fc 'opencode serve --port 393' 2>/dev/null || echo 0)"
