# Debian LXC deployment over SSH

SSH is used to install and update the application. The deployed editor is
accessible directly on the LAN at `http://terminology-mcp.localdomain:3210`
(or the configured deployment hostname), without an SSH tunnel. Cloudflare
routing is not modified.

The target needs Debian systemd, tar, an x86-64 CPU, and network access to Debian
package repositories and npm. Use root or a sudo-capable SSH account. The first
provisioning step installs prerequisites and a checksum-verified official
Node.js 22 runtime under `/opt/terminology-mcp/runtimes/`. Run deployment from a
machine with the repository, Node.js 22+, Python 3, and Paramiko
(`python3-paramiko` on Debian).

Configure local, ignored `.env` entries:

```dotenv
LAN_DEPLOY_SERVER=host-or-ip
LAN_DEPLOY_USER=authoring
LAN_DEPLOY_PASSWORD="your password"
```

`ssh://host:port` and `host:port` are supported too. First inspect the host:

```sh
python3 tools/deploy.py --inspect
```

For a fresh host, provision and deploy from the current **Git commit**:

```sh
python3 tools/deploy.py --provision
```

For subsequent deployments with the runtime already present:

```sh
python3 tools/deploy.py
```

The script packages an allowlist of application files from `HEAD`, builds on
the target, removes development dependencies, and installs the systemd unit
from `deploy/terminology-mcp.service`. Local credentials, Cloudflare tokens,
databases, demos, and test artifacts are not uploaded. Deployment passwords
are passed to SSH/sudo in process memory, not written into the service or
archive. SSH host keys are remembered under ignored `data/deploy/known_hosts`.

Release directories live under `/opt/terminology-mcp/releases/`, with
`/opt/terminology-mcp/current` pointing to the running release. The service runs
as the dedicated `terminology-mcp` account. Persistent SQLite data lives at
`/var/lib/terminology-mcp/terminology.sqlite`; the first deployment starts empty.
Subsequent deployments stop the service before making a database-directory
backup. Earlier release directories and backups are retained.

The service listens on `0.0.0.0:3210`. `/etc/terminology-mcp/environment`
contains the allowed browser origins for the full hostname, short hostname,
and SSH connection's LAN IP. The application rejects other Host headers and
cross-origin writes. The printed editor URL can be opened directly from the LAN.
This is the LAN editor, without authentication; public routing remains a later
deployment step.

Local development still defaults to loopback. For a manual LAN launch, set
`HOST=0.0.0.0` and `TERMINOLOGY_ORIGINS` to a comma-separated list of exact HTTP(S)
origins, including port (for example `http://terminology-mcp:3210`). Configured
HTTPS origins also work behind a separately configured trusted reverse proxy;
the application uses the configured scheme and does not trust forwarded headers.

Operational commands on the target:

```sh
sudo systemctl status terminology-mcp
sudo journalctl -u terminology-mcp -n 100 --no-pager
sudo systemctl restart terminology-mcp
```

If a new release fails to start, inspect the journal before retrying. Keep
the database backup together with its SQLite sidecar files. Deployment does
not automatically roll back data migrations or remove older releases.
