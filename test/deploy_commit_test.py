"""Deployment must use the selected commit even when HEAD and the worktree differ."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import deploy
import deploy_source


class CommitDeploymentTests(unittest.TestCase):
    def test_installer_and_unit_are_pinned_to_selected_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.org')
            for filename in ['src/main.ts', 'public/index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE.md', 'deploy/terminology-mcp.service', 'deploy/install.sh']:
                path = root / filename; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('selected ' + filename + '\n')
            git('add', '.'); git('commit', '-m', 'selected source'); sha = git('rev-parse', 'HEAD')
            installer = root / 'deploy/install.sh'
            installer.write_text('installer from a different HEAD\n')
            git('add', '.'); git('commit', '-m', 'different HEAD')
            installer.write_text('uncommitted installer must never execute\n')
            client = MagicMock()
            client.get_transport.return_value.sock.getpeername.return_value = ('192.0.2.1', 22)
            target = SimpleNamespace(hostname='test.localdomain')
            with patch.object(deploy, 'ROOT', root), patch.object(deploy, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
                deploy.deploy(client, {'LAN_DEPLOY_USER': 'root', 'LAN_DEPLOY_PASSWORD': 'unused'}, target,
                              {'commit': sha, 'branch': 'selected', 'local': False})
            command = run.call_args.args[1]
            self.assertTrue(command.endswith('selected deploy/install.sh\n'))
            self.assertNotIn('different HEAD', command); self.assertNotIn('uncommitted installer', command)
            sftp = client.open_sftp.return_value.__enter__.return_value
            self.assertEqual(sftp.file.return_value.__enter__.return_value.write.call_args_list[0].args[0], b'selected deploy/terminology-mcp.service\n')
            self.assertEqual(installer.read_text(), 'uncommitted installer must never execute\n')

    def test_missing_selected_installer_is_rejected_even_when_tests_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.org')
            (root / 'deploy').mkdir(); (root / 'deploy/terminology-mcp.service').write_text('unit')
            git('add', '.'); git('commit', '-m', 'unit only'); missing = git('rev-parse', 'HEAD')
            # A working-tree installer must not make an old source deployable.
            (root / 'deploy/install.sh').write_text('working tree installer')
            with self.assertRaisesRegex(ValueError, 'deploy/install.sh'):
                deploy_source.validate_source({'commit': missing}, skip_tests=True, root=root)
            git('add', '.'); git('commit', '-m', 'add installer'); complete = git('rev-parse', 'HEAD')
            deploy_source.validate_source({'commit': complete}, skip_tests=True, root=root)
            (root / 'deploy/install.sh').unlink()
            deploy_source.validate_source({'commit': complete}, skip_tests=True, root=root)
