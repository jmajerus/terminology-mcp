"""Exercise the real installer in a temporary filesystem with stub host services."""
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            app = base / 'opt/terminology-mcp'
            data = base / 'var/lib/terminology-mcp'
            etc = base / 'etc/terminology-mcp'
            units = base / 'etc/systemd/system'
            for path in [app / 'runtime/bin', app / 'releases/old', data, etc, units, base / 'var/lock', base / 'proc/123']:
                path.mkdir(parents=True, exist_ok=True)
            (app / 'current').symlink_to(app / 'releases/old')
            (data / 'deployed.json').write_text('{"release":"old"}')
            (data / 'terminology.sqlite').write_text('live database')
            (etc / 'environment').write_text('EXISTING=value\nTERMINOLOGY_ORIGINS=http://old\n')
            (units / 'terminology-mcp.service').write_text('old unit')
            release = app / 'releases/new'
            (base / 'proc/123/cwd').symlink_to(release)
            archive = base / 'upload.tar.gz'
            content = base / 'package.json'
            content.write_text('{}')
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(content, arcname='package.json')
            unit = base / 'upload.service'
            unit.write_text('new unit')
            record = base / 'upload.json'
            record.write_text('{"release":"new"}')
            scripts = {
                'node': 'exit 0',
                'npm': 'if test "$FAIL_MODE" = build && test "$1" = run; then exit 1; fi',
                'getent': 'exit 0', 'id': 'exit 0', 'chown': 'exit 0',
                'curl': 'exit 0', 'sleep': 'exit 0', 'journalctl': 'exit 0',
                'systemctl': 'case "$1" in\n is-active) test "$FAIL_MODE" != health;;\n show) echo 123;;\n *) exit 0;;\nesac',
            }
            # install uses options interspersed with ownership options; strip only
            # those options in Python, keeping the real directory/file operations.
            scripts['install'] = "exec python3 -c 'import os,sys; a=sys.argv[1:]; i=0; r=[]\nwhile i<len(a):\n if a[i] in (\"-o\",\"-g\"): i+=2\n else: r.append(a[i]); i+=1\nos.execv(\"/usr/bin/install\", [\"install\"]+r)' \"$@\""
            for name, script in scripts.items():
                path = app / 'runtime/bin' / name
                path.write_text('#!/bin/sh\n' + script + '\n')
                path.chmod(0o755)
            template = (ROOT / 'deploy/install.sh').read_text()
            for path in ['/opt/terminology-mcp', '/var/lib/terminology-mcp', '/etc/terminology-mcp', '/etc/systemd/system', '/var/lock', '/proc/']:
                template = template.replace(path, str(base) + path)
            result = subprocess.run(['sh'], input=template, text=True, capture_output=True,
                                    env={**os.environ, 'FAIL_MODE': mode, 'RELEASE': str(release),
                                         'RELEASE_ID': 'new', 'COMMIT': 'a' * 40, 'ORIGINS': 'http://new',
                                         'LAN_URL': 'http://test', 'ARCHIVE': str(archive), 'UNIT': str(unit), 'RECORD': str(record)})
            if mode == 'success':
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((app / 'current').resolve(), release)
                self.assertEqual(json.loads((data / 'deployed.json').read_text()), {'release': 'new'})
                self.assertEqual((units / 'terminology-mcp.service').read_text(), 'new unit')
                self.assertEqual((etc / 'environment').read_text(), 'EXISTING=value\nTERMINOLOGY_ORIGINS=http://new\n')
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((app / 'current').resolve(), app / 'releases/old')
                self.assertEqual(json.loads((data / 'deployed.json').read_text()), {'release': 'old'})
                self.assertEqual((units / 'terminology-mcp.service').read_text(), 'old unit')
                self.assertIn('TERMINOLOGY_ORIGINS=http://old', (etc / 'environment').read_text())
            self.assertEqual((data / 'terminology.sqlite').read_text(), 'live database')
            if mode != 'build':
                self.assertEqual((base / 'var/lib/terminology-mcp.backup-new/terminology.sqlite').read_text(), 'live database')
            self.assertFalse(archive.exists())
            return result.stderr

    def test_success_publishes_record_after_activation(self):
        self.exercise('success')

    def test_build_failure_leaves_running_release_and_record_intact(self):
        self.exercise('build')

    def test_failed_health_restores_release_unit_environment_and_record(self):
        self.assertIn('restored previous release', self.exercise('health'))
