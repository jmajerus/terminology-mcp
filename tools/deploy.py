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
from deploy_source import local_source, branch_source, pull_request_source, current_source, validate_source, pr_number

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


def connect(values, quiet=False):
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
    if not quiet:
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
    if not quiet:
        print('SSH host key SHA256:' + fingerprint, flush=True)
    return client, target


def run(client, command, timeout=300, password=None, echo=True):
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
    output = []
    while True:
        if channel.recv_ready():
            chunk = channel.recv(65536).decode(errors='replace')
            output.append(chunk)
            if echo:
                print(chunk, end='', flush=True)
        if channel.recv_stderr_ready():
            chunk = channel.recv_stderr(65536).decode(errors='replace')
            if echo:
                print(chunk, end='', file=sys.stderr, flush=True)
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            break
        if time.monotonic() > deadline:
            channel.close()
            raise RuntimeError('Remote command timed out; inspect the host before retrying.')
        time.sleep(0.05)
    if channel.recv_exit_status():
        raise RuntimeError('Remote command failed. See output above.')
    return ''.join(output)


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


def read_deployed(client, values):
    password = None if values['LAN_DEPLOY_USER'] == 'root' else values['LAN_DEPLOY_PASSWORD']
    data = run(client, "cat /var/lib/terminology-mcp/deployed.json 2>/dev/null || printf 'null\\n'", password=password, echo=False)
    return json.loads(data)


def deploy(client, values, target, source):
    from datetime import datetime, timezone
    import uuid
    password = None if values['LAN_DEPLOY_USER'] == 'root' else values['LAN_DEPLOY_PASSWORD']
    sha = source['commit']
    release_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + sha[:12] + '-' + uuid.uuid4().hex[:8]
    release = '/opt/terminology-mcp/releases/' + release_id
    record = {**source, 'release': release_id, 'at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
    remote = '/tmp/terminology-' + release_id
    with tempfile.TemporaryDirectory(prefix='terminology-deploy-') as temporary:
        archive = Path(temporary) / 'application.tar.gz'
        subprocess.run(['git', 'archive', '--format=tar.gz', f'--output={archive}', sha,
                        'src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE.md'], cwd=ROOT, check=True)
        unit = subprocess.check_output(['git', 'show', sha + ':deploy/terminology-mcp.service'], cwd=ROOT)
        with client.open_sftp() as sftp:
            sftp.put(str(archive), remote + '.tar.gz')
            for suffix, data in [('.service', unit), ('.json', json.dumps(record).encode())]:
                with sftp.file(remote + suffix, 'wb') as output:
                    output.write(data)
            for suffix in ['.tar.gz', '.service', '.json']:
                sftp.chmod(remote + suffix, 0o600)
    peer = client.get_transport().sock.getpeername()[0]
    hosts = {target.hostname, target.hostname.split('.')[0], peer}
    authority = lambda host: '[' + host + ']' if ':' in host else host
    origins = ','.join('http://' + authority(host) + ':3210' for host in sorted(hosts))
    variables = {'RELEASE': release, 'RELEASE_ID': release_id, 'COMMIT': sha, 'ORIGINS': origins,
                 'LAN_URL': 'http://' + authority(peer) + ':3210',
                 'ARCHIVE': remote + '.tar.gz', 'UNIT': remote + '.service', 'RECORD': remote + '.json'}
    exports = ''.join('export ' + key + '=' + shlex.quote(value) + '\n' for key, value in variables.items())
    run(client, exports + (ROOT / 'deploy/install.sh').read_text(), password=password, timeout=300)
    print(f'Deployed {source.get("pr") and "PR #" + str(source["pr"]) or source["branch"]} at {sha}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--inspect', action='store_true', help='Read-only host inventory.')
    action.add_argument('--status', action='store_true', help='Read deployment metadata as JSON over SSH (legacy-server fallback).')
    action.add_argument('--provision', action='store_true', help='Install prerequisites and Node.js 22 before deploying.')
    action.add_argument('--pr', type=pr_number, help='Deploy the exact head of an open, same-repository PR.')
    action.add_argument('--main', action='store_true', help='Deploy origin/main.')
    action.add_argument('--current', action='store_true', help='Redeploy the latest head of the recorded branch or PR.')
    parser.add_argument('--skip-tests', action='store_true', help='Skip isolated selected-commit tests; target build still runs.')
    args = parser.parse_args()
    source = None
    if not (args.inspect or args.status or args.current):
        source = pull_request_source(args.pr) if args.pr else branch_source('main') if args.main else local_source()
        validate_source(source, skip_tests=args.skip_tests)
    values = settings()
    client, target = connect(values, quiet=args.status)
    try:
        if args.inspect:
            run(client, INSPECT, timeout=30)
        elif args.status:
            print(json.dumps(read_deployed(client, values)))
        else:
            if args.current:
                source = current_source(read_deployed(client, values))
                validate_source(source, skip_tests=args.skip_tests)
            password = None if values['LAN_DEPLOY_USER'] == 'root' else values['LAN_DEPLOY_PASSWORD']
            if args.provision:
                provision(client, password)
            deploy(client, values, target, source)
            print(f'Editor: http://{target.hostname}:3210')
    finally:
        client.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        sys.exit(1)
