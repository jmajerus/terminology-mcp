#!/usr/bin/env python3
"""Deploy the committed application to a Debian host over SSH; no secrets uploaded."""
import argparse
import base64
import hashlib
import json
import re
import tarfile
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import urlopen

import paramiko

ROOT = Path(__file__).resolve().parents[1]


def settings():
    # Node's dotenv parser handles quoted values and literal # correctly.
    # The subprocess's secret-bearing output is captured in memory, never logged.
    script = """
      const { readFileSync } = require('node:fs');
      const { parseEnv } = require('node:util');
      const values = parseEnv(readFileSync('.env', 'utf8'));
      const keys = ['LAN_DEPLOY_SERVER', 'LAN_DEPLOY_USER', 'LAN_DEPLOY_PASSWORD'];
      process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k => [k, values[k] || process.env[k] || '']))));
    """
    result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Could not parse deployment settings. Check .env and local Node.js 22+.')
    values = json.loads(result.stdout)
    if any(not value for value in values.values()):
        raise RuntimeError('Set LAN_DEPLOY_SERVER, LAN_DEPLOY_USER, and LAN_DEPLOY_PASSWORD in .env.')
    return values


def connect(values):
    address = values['LAN_DEPLOY_SERVER']
    target = urlsplit(address if '://' in address else '//' + address)
    if not target.hostname or target.username or target.password or target.query or target.fragment or target.path not in ['', '/']:
        raise RuntimeError('LAN_DEPLOY_SERVER must be a host/IP, optional port, or ssh://host:port.')
    if target.scheme and target.scheme != 'ssh':
        raise RuntimeError('Only SSH server addresses are supported.')
    known = ROOT / 'data/deploy/known_hosts'
    known.parent.mkdir(parents=True, exist_ok=True)
    known.touch(exist_ok=True)
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.load_host_keys(str(known))
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'Connecting to {target.hostname}:{target.port or 22}', flush=True)
    try:
        client.connect(target.hostname, port=target.port or 22, username=values['LAN_DEPLOY_USER'],
                       password=values['LAN_DEPLOY_PASSWORD'], timeout=15, auth_timeout=15,
                       banner_timeout=15, look_for_keys=False, allow_agent=False)
    except Exception:
        client.close()
        raise
    key = client.get_transport().get_remote_server_key()
    fingerprint = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
    print('SSH host key SHA256:' + fingerprint, flush=True)
    return client, target


def run(client, command, timeout=300, password=None):
    if password is not None:
        # The child shell discards stdin even on NOPASSWD configurations.
        # No password can reach an npm lifecycle script or other child command.
        command = 'sudo -S -k -p \'\' -- /bin/sh -c ' + shlex.quote('exec </dev/null\n' + command)
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if password is not None:
        stdin.write(password + '\n')
        stdin.flush()
    stdin.channel.shutdown_write()
    # Interleave reads so long build output cannot fill SSH's receive window.
    channel = stdout.channel
    deadline = time.monotonic() + timeout
    while True:
        if channel.recv_ready():
            print(channel.recv(65536).decode(errors='replace'), end='', flush=True)
        if channel.recv_stderr_ready():
            print(channel.recv_stderr(65536).decode(errors='replace'), end='', file=sys.stderr, flush=True)
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            break
        if time.monotonic() > deadline:
            channel.close()
            raise RuntimeError('Remote command timed out; inspect the host before retrying.')
        time.sleep(0.05)
    if channel.recv_exit_status():
        raise RuntimeError('Remote command failed. See output above.')


INSPECT = """set -eu
cat /etc/os-release
id
uname -m
for tool in node npm systemctl curl tar; do command -v "$tool" || true; done
if command -v node >/dev/null 2>&1; then node --version; fi
if command -v npm >/dev/null 2>&1; then npm --version; fi
systemctl list-units --type=service --state=running --no-pager --no-legend
ss -lnt
df -h / /var/lib
ls -ld /opt/terminology-mcp /var/lib/terminology-mcp 2>/dev/null || true
"""


def provision(client, password):
    with urlopen('https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt', timeout=30) as response:
        sums = response.read(100000).decode()
    entry = next((line.split() for line in sums.splitlines()
                  if re.fullmatch(r'[a-f0-9]{64}\s+node-v22\.\d+\.\d+-linux-x64\.tar\.xz', line)), None)
    if not entry:
        raise RuntimeError('Could not identify the official Node.js 22 x64 release.')
    checksum, filename = entry
    with tempfile.TemporaryDirectory(prefix='terminology-node-') as temporary:
        archive = Path(temporary) / filename
        with urlopen('https://nodejs.org/dist/latest-v22.x/' + filename, timeout=60) as response, archive.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise RuntimeError('Official Node.js archive checksum verification failed.')
        with tarfile.open(archive, 'r:xz') as tar:
            root = filename.removesuffix('.tar.xz')
            if any(not member.name.startswith(root + '/') and member.name != root for member in tar.getmembers()):
                raise RuntimeError('Unexpected Node.js archive paths.')
        remote = '/tmp/terminology-' + filename
        with client.open_sftp() as sftp:
            sftp.put(str(archive), remote)
    run(client, f"""set -eu
test "$(uname -m)" = x86_64
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils python3 make g++ pkg-config
echo {shlex.quote(checksum + '  ' + remote)} | sha256sum -c -
install -d -m 0755 /opt/terminology-mcp/runtimes
if test ! -d /opt/terminology-mcp/runtimes/{root}; then
  tar -xJf {shlex.quote(remote)} -C /opt/terminology-mcp/runtimes
fi
ln -sfn /opt/terminology-mcp/runtimes/{root} /opt/terminology-mcp/runtime
rm -f {shlex.quote(remote)}
/opt/terminology-mcp/runtime/bin/node --version
""", timeout=600, password=password)


def deploy(client, values, target):
    password = None if values['LAN_DEPLOY_USER'] == 'root' else values['LAN_DEPLOY_PASSWORD']
    run(client, """set -eu
test "$(id -u)" = 0
export PATH=/opt/terminology-mcp/runtime/bin:$PATH
test -x /opt/terminology-mcp/runtime/bin/node
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
command -v npm
command -v curl
command -v tar
test -d /run/systemd/system
""", password=password)
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    release = f'{stamp}-{sha[:12]}'
    # Archive an explicit allowlist from the commit. Never copy .env, databases,
    # node_modules, test fixtures, or the developer's working directory.
    with tempfile.TemporaryDirectory(prefix='terminology-deploy-') as temporary:
        archive = Path(temporary) / 'application.tar.gz'
        subprocess.run(['git', 'archive', '--format=tar.gz', f'--output={archive}', sha,
                        'src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE.md'],
                       cwd=ROOT, check=True)
        remote_archive = f'/tmp/terminology-{release}.tar.gz'
        remote_unit = f'/tmp/terminology-{release}.service'
        with client.open_sftp() as sftp:
            sftp.put(str(archive), remote_archive)
            sftp.put(str(ROOT / 'deploy/terminology-mcp.service'), remote_unit)
    hosts = {target.hostname, target.hostname.split('.')[0], client.get_transport().sock.getpeername()[0]}
    origins = ','.join('http://' + ('[' + host + ']' if ':' in host else host) + ':3210' for host in sorted(hosts))
    path = '/opt/terminology-mcp/releases/' + release
    run(client, f"""set -eu
export PATH=/opt/terminology-mcp/runtime/bin:$PATH
getent group terminology-mcp >/dev/null || groupadd --system terminology-mcp
id terminology-mcp >/dev/null 2>&1 || useradd --system --gid terminology-mcp --home-dir /var/lib/terminology-mcp --shell /usr/sbin/nologin terminology-mcp
install -d -m 0755 /opt/terminology-mcp/releases
test ! -e {shlex.quote(path)}
install -d -m 0755 {shlex.quote(path)}
tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(path)}
cd {shlex.quote(path)}
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
chown -R root:root {shlex.quote(path)}
chmod -R go-w {shlex.quote(path)}
install -d -m 0700 -o terminology-mcp -g terminology-mcp /var/lib/terminology-mcp
if test -f /var/lib/terminology-mcp/terminology.sqlite; then
  systemctl stop terminology-mcp
  cp -a /var/lib/terminology-mcp /var/lib/terminology-mcp.backup-{release}
fi
install -m 0644 {shlex.quote(remote_unit)} /etc/systemd/system/terminology-mcp.service
install -d -m 0755 /etc/terminology-mcp
printf '%s\\n' {shlex.quote('TERMINOLOGY_ORIGINS=' + origins)} > /etc/terminology-mcp/environment
chmod 0644 /etc/terminology-mcp/environment
ln -sfn {shlex.quote(path)} /opt/terminology-mcp/current.next
mv -Tf /opt/terminology-mcp/current.next /opt/terminology-mcp/current
systemctl daemon-reload
systemctl enable terminology-mcp
systemctl restart terminology-mcp
rm -f {shlex.quote(remote_archive)} {shlex.quote(remote_unit)}
""", password=password)
    try:
        run(client, """set -eu
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3210/api/state >/dev/null; then
    systemctl is-active terminology-mcp
    curl -fsS http://127.0.0.1:3210/api/state | /opt/terminology-mcp/runtime/bin/node -e 'let input=""; process.stdin.on("data", part => input += part); process.stdin.on("end", () => { const state=JSON.parse(input); console.log(JSON.stringify({version:state.version, schemes:state.schemes.length, terms:state.terms.length})); });'
    exit 0
  fi
  sleep 1
done
systemctl status terminology-mcp --no-pager
journalctl -u terminology-mcp -n 40 --no-pager
exit 1
""", timeout=45, password=password)
    except Exception:
        print('Health check failed. The previous release and database backup are retained for recovery.', file=sys.stderr)
        raise
    print(f'\nDeployed commit {sha} to {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true', help='Read-only host inventory; do not deploy.')
    parser.add_argument('--provision', action='store_true', help='Install prerequisites and a checksum-verified official Node.js 22 runtime before deploying.')
    args = parser.parse_args()
    values = settings()
    client, target = connect(values)
    try:
        if args.inspect:
            run(client, INSPECT, timeout=30)
        else:
            password = None if values['LAN_DEPLOY_USER'] == 'root' else values['LAN_DEPLOY_PASSWORD']
            if args.provision:
                provision(client, password)
            deploy(client, values, target)
            print(f'\nEditor: http://{target.hostname}:3210')
    finally:
        client.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        sys.exit(1)
