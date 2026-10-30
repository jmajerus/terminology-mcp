import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import deploy_source as source


class SourceTests(unittest.TestCase):
    def test_invalid_pr_numbers(self):
        for value in ['0', '-1', '1; touch /tmp/nope', '1.5', 'abc', '']:
            with self.assertRaises(ValueError):
                source.pr_number(value)

    def test_closed_and_fork_prs_are_rejected_before_fetch(self):
        for state, fork in [('CLOSED', False), ('MERGED', False), ('OPEN', True)]:
            with patch.object(source, 'command', return_value=json.dumps({'state': state, 'isCrossRepository': fork})), patch.object(source, 'fetch_commit') as fetch:
                with self.assertRaises(ValueError):
                    source.pull_request_source(4)
                fetch.assert_not_called()

    def test_pr_commit_must_match_metadata(self):
        view = {'state': 'OPEN', 'isCrossRepository': False, 'headRefName': 'feature', 'headRefOid': 'a' * 40}
        with patch.object(source, 'command', return_value=json.dumps(view)), patch.object(source, 'fetch_commit', return_value='b' * 40):
            with self.assertRaisesRegex(ValueError, 'changed while fetching'):
                source.pull_request_source(4)
        with patch.object(source, 'command', return_value=json.dumps(view)), patch.object(source, 'fetch_commit', return_value='a' * 40):
            self.assertEqual(source.pull_request_source(4), {'branch': 'feature', 'pr': 4, 'commit': 'a' * 40, 'local': False})

    def test_current_tracks_recorded_source_not_checkout(self):
        with patch.object(source, 'pull_request_source', return_value={'pr': 4}) as pr:
            self.assertEqual(source.current_source({'branch': 'feature', 'pr': 4}), {'pr': 4})
            pr.assert_called_once()
        with patch.object(source, 'branch_source', return_value={'branch': 'main'}) as branch:
            self.assertEqual(source.current_source({'branch': 'main'}), {'branch': 'main'})
            branch.assert_called_once()
        with self.assertRaises(ValueError):
            source.current_source(None)
        for branch in ['HEAD', '', None, '--bad']:
            with self.assertRaises(ValueError):
                source.branch_source(branch)

    def test_fetch_does_not_switch_checkout_or_use_shared_fetch_head(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bare = root / 'origin.git'
            work = root / 'work'
            def run(*args, cwd=root):
                return subprocess.check_output(['git', *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()
            run('init', '--bare', str(bare))
            run('init', '-b', 'main', str(work))
            run('config', 'user.name', 'Test', cwd=work)
            run('config', 'user.email', 'test@example.org', cwd=work)
            (work / 'file').write_text('committed')
            run('add', 'file', cwd=work); run('commit', '-m', 'initial', cwd=work)
            run('remote', 'add', 'origin', str(bare), cwd=work)
            run('push', 'origin', 'main', cwd=work)
            before = run('rev-parse', 'HEAD', cwd=work)
            fetch_head = work / '.git/FETCH_HEAD'
            fetch_head.write_text('another tool owns this file\n')
            (work / 'file').write_text('unsaved local work')
            self.assertEqual(source.branch_source('main', work)['commit'], before)
            self.assertEqual(run('branch', '--show-current', cwd=work), 'main')
            self.assertEqual((work / 'file').read_text(), 'unsaved local work')
            self.assertEqual(run('for-each-ref', 'refs/terminology-deploy', cwd=work), '')
            self.assertEqual(fetch_head.read_text(), 'another tool owns this file\n')


if __name__ == '__main__':
    unittest.main()
