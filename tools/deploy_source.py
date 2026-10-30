"""Resolve a committed deployment source without switching the developer's checkout."""
import json
from pathlib import Path
import re
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]


def command(args, root=ROOT):
    result = subprocess.run(args, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def pr_number(value):
    if not re.fullmatch(r'[1-9][0-9]*', str(value)):
        raise ValueError('--pr needs a positive pull request number.')
    return int(value)


def fetch_commit(ref, root=ROOT):
    # A private ref avoids races with FETCH_HEAD from other tools/deploys.
    temporary = 'refs/terminology-deploy/' + uuid.uuid4().hex
    try:
        command(['git', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', f'{ref}:{temporary}'], root)
        return command(['git', 'rev-parse', temporary + '^{commit}'], root)
    finally:
        subprocess.run(['git', 'update-ref', '-d', temporary], cwd=root, capture_output=True)


def branch_source(branch, root=ROOT):
    if branch == 'HEAD' or not branch or branch.startswith('-'):
        raise ValueError('A detached deployment has no branch to follow; select --main or --pr.')
    command(['git', 'check-ref-format', '--branch', branch], root)
    return {'branch': branch, 'commit': fetch_commit('refs/heads/' + branch, root), 'local': False}


def pull_request_source(number, root=ROOT):
    number = pr_number(number)
    view = json.loads(command(['gh', 'pr', 'view', str(number), '--json', 'state,headRefName,headRefOid,isCrossRepository'], root))
    if view['state'] != 'OPEN':
        raise ValueError(f'PR #{number} is not open. Select --main instead.')
    if view['isCrossRepository']:
        raise ValueError('Fork PR deployments are not supported; select a branch in this repository.')
    commit = fetch_commit(f'refs/pull/{number}/head', root)
    if commit != view['headRefOid']:
        raise ValueError('The PR changed while fetching; retry to deploy its latest head.')
    return {'branch': view['headRefName'], 'pr': number, 'commit': commit, 'local': False}


def current_source(record, root=ROOT):
    if not record:
        raise ValueError('The server has no deployment record. Select --main, --pr, or the checked-out commit first.')
    if record.get('pr'):
        return pull_request_source(record['pr'], root)
    return branch_source(record.get('branch'), root)


def local_source(root=ROOT):
    # Deliberately committed content only; secrets and uncommitted files are never packaged.
    return {'branch': command(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root),
            'commit': command(['git', 'rev-parse', 'HEAD'], root), 'local': True}


def validate_source(source, skip_tests=False, root=ROOT):
    import tarfile
    import tempfile
    import io
    sha = source['commit']
    # Validate deployment capability before connecting or changing the host.
    try:
        command(['git', 'cat-file', '-e', sha + ':deploy/terminology-mcp.service'], root)
    except RuntimeError as error:
        raise ValueError('Selected commit lacks Debian deployment support. Merge the deployment PR before deploying main.') from error
    if skip_tests:
        return
    with tempfile.TemporaryDirectory(prefix='terminology-check-') as directory:
        archive = subprocess.check_output(['git', 'archive', sha], cwd=root)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as tar:
            tar.extractall(directory, filter='data')
        for args in [['npm', 'ci', '--no-audit', '--no-fund'], ['npm', 'run', 'build'], ['npm', 'test']]:
            subprocess.run(args, cwd=directory, check=True)
        if 'test:deploy' in json.loads((Path(directory) / 'package.json').read_text()).get('scripts', {}):
            subprocess.run(['npm', 'run', 'test:deploy'], cwd=directory, check=True)
