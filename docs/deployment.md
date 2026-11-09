# Debian LXC deployment over SSH

SSH is used to install and update the application. The deployed editor is
accessible directly on the LAN at `http://terminology-mcp.localdomain:8000`
(or the configured deployment hostname), without an SSH tunnel. Cloudflare
routing is not modified.

The target needs Debian systemd, tar, an x86-64 CPU, and network access to Debian
package repositories and npm. Use root or a sudo-capable SSH account. The first
provisioning step installs prerequisites and a checksum-verified official
Node.js 22 runtime under `/opt/terminology-mcp/runtimes/`. Run deployment from a
machine with the repository, Git, Node.js 22+, Python 3.12+, and Paramiko
(`python3-paramiko` on Debian). PR selection and GitHub status also require
the authenticated GitHub CLI (`gh auth login`) and access to `origin`.

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

Scheme administration uses the server’s existing runtime directly, with no npm
needed to run the commands. After deploying a release containing the CLI:

```sh
sudo -u terminology-mcp /opt/terminology-mcp/runtime/bin/node /opt/terminology-mcp/current/dist/cli.js rename my-scheme "New name" --db /var/lib/terminology-mcp/terminology.sqlite
sudo -u terminology-mcp /opt/terminology-mcp/runtime/bin/node /opt/terminology-mcp/current/dist/cli.js delete my-scheme --db /var/lib/terminology-mcp/terminology.sqlite
```

These commands preview changes. Append `--yes` to apply. Run them on the server
as the service account so the database and its SQLite journal retain the correct
ownership. Rename changes the display name and preserves the scheme ID.

## VS Code deployment controls

Install this workspace's recommended **Task Buttons**
(`spencerwmiles.vscode-task-buttons`) and **Status Probe**
(`jmajerus.status-probe`) extensions, as in corpus-mcp and quote-mcp.
The **Deploy Terminology** status-bar menu offers:

- **Redeploy current branch**: follow the latest head of the PR or branch
  recorded on the server, regardless of the local checkout.
- **Switch to main**: deploy the latest `origin/main`.
- **Switch to a pull request…**: enter an open, same-repository PR number.
- **Deploy checked-out commit**: deploy committed `HEAD`.
- **Deploy checked-out commit without tests**: skip local validation tests;
  the remote build and health checks still run.

These actions are also available through **Tasks: Run Task**. The adjacent
status item opens the LAN editor when clicked. Its tooltip shows the running
branch/PR, commit, deployment time, and vocabulary counts. It refreshes every
five minutes and after a deployment task, with a spinner while the task runs.
`↓N` indicates commits available to deploy; merged/closed PRs prompt switching
to main. Unavailable GitHub information or diverged history produces a warning
instead of claiming that the deployment is current. Status checks read remote
refs without fetching or changing the checkout.

Equivalent commands:

```sh
npm run deploy -- --pr 4
npm run deploy -- --main
npm run deploy -- --current
npm run deploy
npm run deploy -- --skip-tests
npm run status
```

PR selection rejects closed/merged and fork PRs, then verifies the fetched
commit against GitHub's PR head. Fetching uses a temporary private ref and
preserves the working tree and `FETCH_HEAD`. By default, the selected commit
is tested in an isolated temporary directory (`npm ci`, build, unit/API/status
tests, and deployment tests when provided). Uncommitted files are excluded.
The selected source must include both `deploy/terminology-mcp.service` and
`deploy/install.sh`; a revision missing either is rejected before deployment,
even with `--skip-tests`. Merge the deployment controls before using
**Switch to main** if main predates them.

Status uses `http://<LAN_DEPLOY_SERVER hostname>:8000`. Set
`TERMINOLOGY_STATUS_URL` in `.env` to override it (HTTP(S), no embedded
credentials). For releases predating `/health`, it reads `/api/state` and
uses SSH to read the deployment record. A host without a record needs one
deployment with these tools before **Redeploy current branch** can follow it.

## Release activation and recovery

The script packages an allowlist of application files from the selected commit, builds on
the target, removes development dependencies, and installs the systemd unit
from that commit's `deploy/terminology-mcp.service`. The installer is also read
from that exact commit, so another checkout or uncommitted installer edits
cannot change the cutover or recovery behavior. Local credentials, Cloudflare tokens,
databases, demos, and test artifacts are not uploaded. Deployment passwords
are passed to SSH/sudo in process memory, not written into the service or
archive. SSH host keys are remembered under ignored `data/deploy/known_hosts`.

Release directories live under `/opt/terminology-mcp/releases/`, with
`/opt/terminology-mcp/current` pointing to the running release. The service runs
as the dedicated `terminology-mcp` account. Application code is readable and
directories are traversable by the `authoring` login, matching corpus-mcp and
quote-mcp; use `cd /opt/terminology-mcp/current` to inspect the running version
without finding its timestamped release directory or becoming root.
The release's `rollback` directory remains root-only, and runtime data and
environment settings retain their separate restricted permissions.
Persistent SQLite data lives at
`/var/lib/terminology-mcp/terminology.sqlite`; the first deployment starts empty.
Subsequent deployments stop the service before making a database-directory
backup. Earlier release directories and backups are retained.

A host lock prevents overlapping deployments. After switching releases, the
installer checks the LAN API and verifies that systemd's process is running
from the selected release directory. Only then does it publish the record at
`/var/lib/terminology-mcp/deployed.json`. Each release also contains its own
record; `/health` returns that running release's identity and counts without
vocabulary contents. Records contain only branch, commit, optional PR number,
timestamp, release identifier, and whether the source was local.

The service listens on `0.0.0.0:8000`. `/etc/terminology-mcp/env`
contains the allowed browser origins for the full hostname, short hostname,
and SSH connection's LAN IP. The application rejects other Host headers and
cross-origin writes. The printed editor URL can be opened directly from the LAN.
Direct LAN access remains available.

Cloudflare decides who reaches the server through its public hostnames, and
the server decides what each one may do:

- **Routing** (tunnel routes, DNS) and **sign-in** (Access applications,
  Managed OAuth) are configured in Cloudflare only.
- **Hostnames:** a request through Cloudflare is served under the hostname
  it arrived on, as HTTPS. Adding a public hostname needs no change here.
- **Access settings:** the server needs only `ACCESS_TEAM_DOMAIN` (your Zero
  Trust login domain, `https://<name>.cloudflareaccess.com`), to check that a
  sign-in came from your Access account. See [MCP access](mcp.md).
- **Requests with an Access assertion** are signed in; writes, `/mcp` and
  subscriber routes need one.
- **Requests through Cloudflare with no assertion** got in because an
  Access Bypass policy let them. They are read-only visitors.

### Public read-only

To let anyone browse the vocabulary, give visitors a hostname of their own.
Leave the owner's hostname, with MCP and its Managed OAuth, as it is: that's
where you edit, as with the sibling apps. Everything is set up in Cloudflare:

| Hostname | Tunnel route | Access | Used for |
| --- | --- | --- | --- |
| `vocabulary.majerus.us` | `http://terminology-mcp.localdomain:8000` | **Bypass** for **Everyone** | Reading, by anyone |
| `terminology-mcp.majerus.us` | the same | Owner only | Editing and MCP |

1. Add the visitors' hostname as a public hostname on the tunnel, routed to
   the same service. Don't redirect it to the owner's hostname: a redirect
   sends visitors to its login.
2. In Cloudflare Zero Trust (Access → Applications), add an application for
   the visitors' hostname with a **Bypass** policy for **Everyone**, and
   check the policy is assigned to the application.
3. Check with `curl -s https://vocabulary.majerus.us/api/viewer`, which
   should answer `{"canEdit":false,"via":"public"}`.

Optionally, set `TERMINOLOGY_EDIT_URL=https://terminology-mcp.majerus.us` in
the env file. Visitors' top bar then shows **Sign in to edit**, which opens
the same page, including the selected term, on the editing hostname.
Without it they see only a **Read-only** badge.

What visitors get:

- **Reads:** every page and every `GET` read, including SKOS export and
  pinned historical reads.
- **Email addresses** in JSON responses, such as proposers and change
  authors, read "an editor".
- **Refused with 401:**
  - writes: every non-`GET` request, including import and operation
    previews, so a visitor can't make the server fetch a SPARQL endpoint;
  - `/mcp`;
  - `/api/subscribers`.
- **Editor pages** grey out their editing controls in place, with a tooltip,
  and make fields read-only.

What protects editing:

- **No sign-in on the visitors' hostname.** Access forwards no assertion
  under the Bypass, and the server doesn't treat the `CF_Authorization`
  cookie as one.
- **Assertions:** a request that carries an assertion must have a valid one,
  or it is refused with 403.
- **Cross-site writes** are refused: a write's `Origin` must match the
  hostname it arrived on.
- **Audiences:** the token's audience isn't checked, so every Access
  application in your account must admit only you. An application that let
  other people sign in would give them editing here too.
- **If an Access application were deleted** or misconfigured, its hostname
  would become readable by anyone, as `vocabulary.majerus.us` already is.
  It would not become writable.
- **LAN:** direct LAN requests need a configured hostname, as before, so a
  page elsewhere can't use DNS rebinding to reach the server.

All three sibling services use `/etc/<service>/env`: `/etc/quote-mcp/env`,
`/etc/corpus-mcp/env`, and `/etc/terminology-mcp/env`. Development checkouts
continue to use `.env` at the repository root. Server files stay outside
release directories so application deployments preserve their settings.
Edit Terminology's settings with `sudoedit /etc/terminology-mcp/env`, then
run `sudo systemctl restart terminology-mcp`.

Deployments migrate Terminology's former `environment` file automatically,
preserving its settings except for the deploy-managed allowed origins. The
original is retained in the release's root-only rollback directory; the old
live filename is removed after a healthy activation. Failed activation
restores the original files and unit. If both live filenames exist and differ,
deployment stops before cutover so settings cannot be silently discarded.

Local development still defaults to loopback. For a manual LAN launch, set
`HOST=0.0.0.0` and `TERMINOLOGY_ORIGINS` to a comma-separated list of exact HTTP(S)
origins, including port (for example `http://terminology-mcp:8000`). Configured
HTTPS origins also work behind a separately configured trusted reverse proxy;
the application uses the configured scheme and does not trust forwarded headers.

Operational commands on the target:

```sh
sudo systemctl status terminology-mcp
sudo journalctl -u terminology-mcp -n 100 --no-pager
sudo systemctl restart terminology-mcp
```

If activation or its health check fails, the installer restores the previous
release symlink, systemd unit, and environment, then restarts it. A failed first
deployment stops and disables the service, removes the failed release symlink,
and restores any pre-existing unit/environment (or removes newly created ones).
The database and failed release remain available for inspection. Inspect the journal before retrying.
The live database is never automatically replaced: migrations may require
manual recovery from the retained backup, including SQLite sidecar files.
Older releases are not removed automatically.

Check the deployment tools locally with `npm run test:deploy` and `npm test`.
