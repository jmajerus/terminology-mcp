#!/bin/sh
# Called over SSH with validated paths exported by tools/deploy.py.
set -eu
umask 0027
export PATH=/opt/terminology-mcp/runtime/bin:$PATH
test -x /opt/terminology-mcp/runtime/bin/node || { echo 'Run --provision to install the dedicated Node.js runtime.' >&2; exit 1; }
for tool in npm curl tar flock systemctl cmp; do command -v "$tool" >/dev/null; done
/opt/terminology-mcp/runtime/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
exec 9>/var/lock/terminology-mcp-deploy.lock
flock -n 9 || { echo 'Another deployment is already running.' >&2; exit 1; }
trap 'rm -f "$ARCHIVE" "$UNIT" "$RECORD"' EXIT
getent group terminology-mcp >/dev/null || groupadd --system terminology-mcp
id terminology-mcp >/dev/null 2>&1 || useradd --system --gid terminology-mcp --home-dir /var/lib/terminology-mcp --shell /usr/sbin/nologin terminology-mcp
install -d -m 0755 /opt/terminology-mcp/releases
test ! -e "$RELEASE"
install -d -m 0755 "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
cd "$RELEASE"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
install -m 0644 "$RECORD" "$RELEASE/deployed.json"
chown -R root:terminology-mcp "$RELEASE"
# Match corpus-mcp/quote-mcp: application releases are browsable by the
# authoring login. Runtime state, environment and rollback material have
# their own restricted permissions below.
chmod -R a+rX,go-w "$RELEASE"
install -d -m 0700 -o terminology-mcp -g terminology-mcp /var/lib/terminology-mcp
install -d -m 0700 "$RELEASE/rollback"
previous=$(readlink /opt/terminology-mcp/current || true)
if test -f /etc/systemd/system/terminology-mcp.service; then
  cp -a /etc/systemd/system/terminology-mcp.service "$RELEASE/rollback/service"
fi
for name in env environment; do
  if test -f "/etc/terminology-mcp/$name"; then
    cp -a "/etc/terminology-mcp/$name" "$RELEASE/rollback/$name"
  fi
done
if test -f /etc/terminology-mcp/env && test -f /etc/terminology-mcp/environment && ! cmp -s /etc/terminology-mcp/env /etc/terminology-mcp/environment; then
  echo 'Both /etc/terminology-mcp/env and the legacy environment file exist and differ. Consolidate settings into env before deploying.' >&2
  exit 1
fi
config=/etc/terminology-mcp/env
if test ! -f "$config" && test -f /etc/terminology-mcp/environment; then config=/etc/terminology-mcp/environment; fi
cutover=0
recover() {
  code=$?
  trap - EXIT
  if test "$code" != 0 && test "$cutover" = 1; then
    systemctl stop terminology-mcp || true
    for name in env environment; do
      if test -f "$RELEASE/rollback/$name"; then
        cp -a "$RELEASE/rollback/$name" "/etc/terminology-mcp/$name"
      else
        rm -f "/etc/terminology-mcp/$name"
      fi
    done
    rm -f /etc/terminology-mcp/env.next
    if test -n "$previous" && test -d "$previous"; then
      ln -sfn "$previous" /opt/terminology-mcp/current.next
      mv -Tf /opt/terminology-mcp/current.next /opt/terminology-mcp/current
      if test -f "$RELEASE/rollback/service"; then
        cp -a "$RELEASE/rollback/service" /etc/systemd/system/terminology-mcp.service
      fi
      systemctl daemon-reload
      systemctl restart terminology-mcp || true
      echo "Deployment failed; restored previous release $previous. Database backup retained; live database not overwritten." >&2
    else
      systemctl disable terminology-mcp || true
      rm -f /opt/terminology-mcp/current /opt/terminology-mcp/current.next
      if test -f "$RELEASE/rollback/service"; then
        cp -a "$RELEASE/rollback/service" /etc/systemd/system/terminology-mcp.service
      else
        rm -f /etc/systemd/system/terminology-mcp.service
      fi
      systemctl daemon-reload
      echo 'First deployment failed. Service stopped and disabled; database and release retained for inspection.' >&2
    fi
  fi
  rm -f "$ARCHIVE" "$UNIT" "$RECORD"
  exit "$code"
}
trap recover EXIT
cutover=1
if systemctl cat terminology-mcp >/dev/null 2>&1; then systemctl stop terminology-mcp; fi
if test -f /var/lib/terminology-mcp/terminology.sqlite; then
  cp -a /var/lib/terminology-mcp "/var/lib/terminology-mcp.backup-$RELEASE_ID"
fi
install -m 0644 "$UNIT" /etc/systemd/system/terminology-mcp.service
install -d -m 0755 /etc/terminology-mcp
{ grep -v '^TERMINOLOGY_ORIGINS=' "$config" 2>/dev/null || true; printf '%s\n' "TERMINOLOGY_ORIGINS=$ORIGINS"; } > /etc/terminology-mcp/env.next
chown root:terminology-mcp /etc/terminology-mcp/env.next
chmod 0640 /etc/terminology-mcp/env.next
mv -f /etc/terminology-mcp/env.next /etc/terminology-mcp/env
ln -sfn "$RELEASE" /opt/terminology-mcp/current.next
mv -Tf /opt/terminology-mcp/current.next /opt/terminology-mcp/current
systemctl daemon-reload
systemctl enable terminology-mcp
systemctl restart terminology-mcp
healthy=0
for attempt in $(seq 1 20); do
  if curl -fsS --connect-timeout 2 --max-time 4 "$LAN_URL/api/state" >/dev/null 2>&1 && systemctl is-active --quiet terminology-mcp; then
    pid=$(systemctl show terminology-mcp --property=MainPID --value)
    if test "$(readlink "/proc/$pid/cwd")" = "$RELEASE"; then healthy=1; break; fi
  fi
  sleep 1
done
if test "$healthy" != 1; then
  journalctl -u terminology-mcp -n 30 --no-pager || true
  echo 'Release did not pass its LAN health check.' >&2
  exit 1
fi
# Only a healthy release becomes the source for --current and legacy probes.
rm -f /etc/terminology-mcp/environment
install -m 0640 -o root -g terminology-mcp "$RELEASE/deployed.json" /var/lib/terminology-mcp/deployed.json.next
mv -f /var/lib/terminology-mcp/deployed.json.next /var/lib/terminology-mcp/deployed.json
echo "Healthy release $RELEASE_ID ($COMMIT)"
