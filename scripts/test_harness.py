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

    def stamp(self, name, sleep=0.0, code=0):
        """A check that records when it started and ended, then exits with `code`."""
        return {'cwd': '.', 'timeout': 10, 'argv': [sys.executable, '-c',
            'import json, sys, time; from pathlib import Path; started = time.time(); '
            f'time.sleep({sleep}); Path("stamps").mkdir(exist_ok=True); '
            f'Path("stamps/{name}.json").write_text(json.dumps([started, time.time()])); sys.exit({code})']}

    def stamps(self, name):
        path = self.root / 'stamps' / f'{name}.json'
        return json.loads(path.read_text()) if path.exists() else None

    def test_parallel_checks_run_together_after_their_requirements(self):
        (self.root / '.gitignore').write_text('.harness/\nstamps/\n')
        self.config['checks'].update({
            'build': self.stamp('build', 0.3),
            'one': {**self.stamp('one', 1.0), 'parallel': True, 'requires': ['build']},
            'two': {**self.stamp('two', 1.0), 'parallel': True, 'requires': ['build']},
        })
        self.config['jobs'] = 2
        # Listed before the build: requirements still run first.
        self.config['tickets'] = {'T04': ['one', 'two', 'behavior']}
        self.save_config()
        self.cli('check')
        build, one, two = self.stamps('build'), self.stamps('one'), self.stamps('two')
        self.assertLessEqual(build[1], min(one[0], two[0]))
        # Both ran at the same time rather than one after the other.
        self.assertLess(max(one[0], two[0]), min(one[1], two[1]))
        report = json.loads((self.root / '.harness/full.json').read_text())
        self.assertEqual([c['name'] for c in report['checks']], ['behavior', 'build', 'one', 'two'])
        self.assertEqual(report['jobs'], 2)
        self.cli('review')

    def test_a_parallel_failure_starts_nothing_more_and_fails_the_run(self):
        (self.root / '.gitignore').write_text('.harness/\nstamps/\n')
        self.config['checks'].update({
            'first': {**self.stamp('first', code=3), 'parallel': True},
            'second': {**self.stamp('second'), 'parallel': True},
        })
        self.config['tickets'] = {'T04': ['behavior', 'first', 'second']}
        self.save_config()
        self.assertIn('first failed', self.cli('check', '--jobs', '1', code=1))
        self.assertIsNone(self.stamps('second'))
        report = json.loads((self.root / '.harness/full.json').read_text())
        self.assertEqual((report['status'], [c['exit_code'] for c in report['checks']]), ('FAILED', [0, 3]))
        self.cli('review', code=1)

    def test_only_runs_the_chosen_checks_and_their_requirements_and_never_authorizes_review(self):
        (self.root / '.gitignore').write_text('.harness/\nstamps/\n')
        self.config['checks'].update({
            'build': self.stamp('build'),
            'browser': {**self.stamp('browser'), 'parallel': True, 'requires': ['build']},
            'unrelated': self.stamp('unrelated'),
        })
        self.config['tickets'] = {'T04': ['behavior', 'browser', 'unrelated']}
        self.save_config()
        self.assertIn('FOCUSED checks PASSED', self.cli('check', '--only', 'browser'))
        self.assertIsNotNone(self.stamps('build'))
        self.assertIsNotNone(self.stamps('browser'))
        self.assertIsNone(self.stamps('unrelated'))
        self.assertIn('focused: PASSED', self.cli('status'))
        self.assertIn('full: NOT RUN', self.cli('status'))
        self.cli('review', code=1)
        self.assertIn('Unknown check', self.cli('check', '--only', 'missing', code=1))

    def test_invalid_requirements_are_refused_before_anything_runs(self):
        self.config['checks'].update({
            'a': {**self.stamp('a'), 'requires': ['b']},
            'b': {**self.stamp('b'), 'requires': ['a']},
            'p': {**self.stamp('p'), 'parallel': True},
            'needs-p': {**self.stamp('needs-p'), 'requires': ['p']},
        })
        self.save_config()
        self.assertIn('cycle', self.cli('check', '--only', 'a', code=1))
        self.assertIn('runs in parallel', self.cli('check', '--only', 'needs-p', code=1))
        self.assertIsNone(self.stamps('a'))
        self.assertIsNone(self.stamps('p'))

    def test_a_parallel_timeout_fails_the_run(self):
        self.config['checks']['slow'] = {**self.stamp('slow', 5), 'parallel': True, 'timeout': 0.2}
        self.config['tickets'] = {'T04': ['behavior', 'slow']}
        self.save_config()
        self.assertIn('slow timed out', self.cli('check', '--jobs', '2', code=1))
        self.assertEqual(json.loads((self.root / '.harness/full.json').read_text())['status'], 'FAILED')
        self.cli('review', code=1)


if __name__ == '__main__':
    unittest.main()
