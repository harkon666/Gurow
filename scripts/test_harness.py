"""Exercise the harness CLI with real Git repos and child processes in /tmp."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class NativeQualificationConfigTests(unittest.TestCase):
    def test_native_qualification_is_opt_in_not_automatically_appended(self):
        root = Path(__file__).resolve().parents[1]
        config = json.loads((root / 'harness.json').read_text())
        # The v1 collector qualification is historical (ADR 0019); it stays opt-in.
        native = 't06-l3-01-qualify-v1'
        for profile in ('quick', 'full'):
            self.assertNotIn(native, config['profiles'][profile])
        for checks in config['tickets'].values():
            self.assertNotIn(native, checks)
        for check in ('collector-tests', 'editor-lifecycle'):
            self.assertIn(check, config['profiles']['full'])
            self.assertIn(check, config['tickets']['T06-L3-01'])
        package = json.loads((root / 'frontend/package.json').read_text())
        self.assertEqual(package['scripts']['qualify:native:v1'].split(),
                         config['checks'][native]['argv'])
        # The headed v2 capture takes over a desktop window: no routine check runs it.
        for check in config['checks'].values():
            self.assertNotIn('scripts/benchmark/run.ts', check['argv'])
        self.assertIn('scripts/benchmark/run.ts', package['scripts']['capture:p1'])


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gurow-harness-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        shutil.copyfile(Path(__file__).with_name('harness.py'), self.root / 'scripts/harness.py')
        self.write('.gitignore', '.harness/\n')
        self.write('app.txt', 'before\n')
        self.write('behavior_test.py', 'print("observable check executed")\n')
        self.write('docs/tickets/README.md', '| [T04](04.md) | [#5](https://github.com/harkon666/Gurow/issues/5) |\n')
        # Only the external GitHub transport is stubbed. Runner checks execute
        # real programs; failures and repository mutations are observed via CLI.
        self.write('bin/gh', '#!' + sys.executable + '\nimport json\nprint(json.dumps(' + repr({
            'number': 5, 'title': 'T04 fixture', 'state': 'OPEN', 'updatedAt': '2026-09-10',
            'url': 'https://github.com/harkon666/Gurow/issues/5',
            'body': '## Acceptance criteria\n\n- [ ] Restores the observable scene.\n\n## Blocked by\nNone\n',
        }) + '))\n')
        (self.root / 'bin/gh').chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']}
        self.config = {
            'checks': {'behavior': {'cwd': '.', 'argv': [sys.executable, 'behavior_test.py'], 'timeout': 10}},
            'profiles': {'quick': ['behavior'], 'full': ['behavior']},
            'tickets': {'T04': ['behavior']},
        }
        self.save_config()
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Harness Test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
        self.cli('start', 'T04', '--base', 'HEAD')
        self.fill_mapping()

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def save_config(self):
        self.write('harness.json', json.dumps(self.config))

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.STDOUT)

    def cli(self, *args, code=0):
        result = subprocess.run([sys.executable, '-B', 'scripts/harness.py', *args], cwd=self.root,
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def fill_mapping(self):
        path = self.root / '.harness/task.json'
        current = json.loads(path.read_text())
        current['criteria'][0].update(test='behavior_test.py', assertion='Reload and compare visible card coordinates.')
        path.write_text(json.dumps(current))

    def test_quick_does_not_authorize_review_and_full_records_real_logs(self):
        self.cli('check', '--quick')
        self.cli('review', code=1)
        self.cli('check')
        self.cli('review')
        report = json.loads((self.root / '.harness/full.json').read_text())
        self.assertIn('observable check executed', (self.root / report['checks'][0]['log']).read_text())
        self.assertIn('Spec review', (self.root / '.harness/review.md').read_text())

    def test_new_untracked_file_and_task_changes_invalidate_success(self):
        self.cli('check')
        self.write('new-feature.txt', 'not tested\n')
        self.assertIn('STALE', self.cli('status'))
        self.cli('review', code=1)
        self.cli('check')
        path = self.root / '.harness/task.json'
        current = json.loads(path.read_text())
        current['notes'] = 'changed test plan'
        path.write_text(json.dumps(current))
        self.cli('review', code=1)

    def test_failed_rerun_replaces_previous_success_and_stops_later_checks(self):
        self.cli('check')
        self.write('behavior_test.py', 'raise SystemExit(7)\n')
        self.config['checks']['later'] = {'cwd': '.', 'argv': [sys.executable, '-c',
            'from pathlib import Path; Path("unexpected.txt").write_text("ran")'], 'timeout': 10}
        self.config['profiles']['full'].append('later')
        self.save_config()
        self.cli('check', code=1)
        report = json.loads((self.root / '.harness/full.json').read_text())
        self.assertEqual(report['status'], 'FAILED')
        self.assertEqual(report['checks'][0]['exit_code'], 7)
        self.assertFalse((self.root / 'unexpected.txt').exists())
        self.cli('review', code=1)

    def test_mutating_source_during_checks_cannot_pass(self):
        self.write('behavior_test.py', 'from pathlib import Path\nPath("app.txt").write_text("changed during run")\n')
        self.assertIn('changed during checks', self.cli('check', code=1))
        self.cli('review', code=1)

    def test_missing_acceptance_or_rewritten_criteria_cannot_pass(self):
        self.config['tickets'] = {}
        self.save_config()
        self.assertIn('No acceptance checks', self.cli('check', code=1))
        self.config['tickets'] = {'T04': ['behavior']}
        self.save_config()
        path = self.root / '.harness/task.json'
        current = json.loads(path.read_text())
        current['criteria'] = []
        path.write_text(json.dumps(current))
        self.assertIn('criteria differ', self.cli('check', code=1))

    def test_timeout_and_unknown_ticket_fail_explicitly(self):
        self.write('behavior_test.py', 'import time\ntime.sleep(10)\n')
        self.config['checks']['behavior']['timeout'] = 0.1
        self.save_config()
        self.cli('check', code=1)
        self.assertEqual(json.loads((self.root / '.harness/full.json').read_text())['status'], 'FAILED')
        self.assertIn('active task', self.cli('start', 'T05', '--base', 'HEAD', code=1))

    def test_review_rejects_missing_or_modified_evidence(self):
        self.cli('check')
        report = json.loads((self.root / '.harness/full.json').read_text())
        (self.root / report['checks'][0]['log']).write_text('different output')
        self.assertIn('Evidence log missing/changed', self.cli('review', code=1))

    def test_modified_or_missing_reviewer_spec_cannot_reuse_passing_evidence(self):
        self.cli('check')
        spec = self.root / '.harness/spec.md'
        spec.write_text('# Different spec\nNo restoration required\n')
        self.assertIn('STALE', self.cli('status'))
        self.cli('review', code=1)
        self.assertIn('spec.md differs', self.cli('check', code=1))
        spec.unlink()
        self.cli('review', code=1)
        self.assertIn('spec.md differs', self.cli('check', code=1))


if __name__ == '__main__':
    unittest.main()
