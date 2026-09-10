#!/usr/bin/env python3
"""Local verification and review handoff. No model API or external writes."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.harness'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(path)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def source_hash():
    # Include dirty/untracked source and file modes, not only HEAD. Build outputs
    # must be gitignored; otherwise they correctly invalidate the result.
    paths = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT
    ).split(b'\0')
    result = hashlib.sha256()
    for name in sorted(set(paths) - {b''}):
        if name.startswith(b'.harness/'):
            continue
        path = ROOT / os.fsdecode(name)
        result.update(name + b'\0')
        if path.is_symlink():
            result.update(b'link:' + os.fsencode(os.readlink(path)))
        elif path.is_file():
            result.update(str(path.stat().st_mode & 0o777).encode() + b'\0')
            result.update(path.read_bytes())
        else:
            result.update(b'deleted')
        result.update(b'\0')
    return result.hexdigest()


def task():
    path = STATE / 'task.json'
    if not path.exists():
        raise ValueError('Run start Txx --base <ref> first.')
    return read_json(path)


def input_hash():
    return digest((source_hash() + (STATE / 'task.json').read_text()
                   + (STATE / 'issue.json').read_text()).encode())


def acceptance_criteria(body):
    match = re.search(r'^## Acceptance criteria\s*\n(.*?)(?=^## |\Z)', body, re.M | re.S | re.I)
    if not match:
        raise ValueError('Issue has no Acceptance criteria section; inspect the canonical issue.')
    criteria = re.findall(r'^- \[[ xX]\] (.+)$', match[1], re.M)
    if not criteria:
        raise ValueError('No checkbox criteria found; inspect the canonical issue.')
    return criteria


def start(args):
    if (STATE / 'task.json').exists():
        raise ValueError('An active task already exists. Resume it, or archive .harness before starting another.')
    ticket = args.ticket.upper()
    index = (ROOT / 'docs/tickets/README.md').read_text()
    row = re.search(r'\[' + re.escape(ticket) + r'\]\([^)]+\) \| \[#(\d+)\]', index)
    if not row:
        raise ValueError(f'{ticket} is not in docs/tickets/README.md.')
    base = git('merge-base', args.base, 'HEAD')
    issue = json.loads(subprocess.check_output([
        'gh', 'issue', 'view', row[1], '--repo', 'harkon666/Gurow',
        '--json', 'number,title,body,url,state,updatedAt',
    ], cwd=ROOT))
    criteria = acceptance_criteria(issue['body'])
    STATE.mkdir(exist_ok=True)
    write_json(STATE / 'issue.json', issue)
    (STATE / 'spec.md').write_text(f"# {issue['title']}\n\n{issue['url']}\n\n{issue['body']}")
    write_json(STATE / 'task.json', {
        'ticket': ticket, 'base': base, 'issue_url': issue['url'],
        'criteria': [{'id': f'AC{i}', 'requirement': text, 'test': '', 'assertion': ''}
                     for i, text in enumerate(criteria, 1)],
        'notes': '',
    })
    print(f'{ticket}: pinned base {base}\nSpec: .harness/spec.md\nFill test + assertion for every AC in .harness/task.json.')
    print('Starting a harness task does not verify ticket blockers or authorize scope changes.')


def proof_gaps(current):
    expected = acceptance_criteria(read_json(STATE / 'issue.json')['body'])
    rows = current.get('criteria', [])
    if [r.get('requirement') for r in rows] != expected:
        return ['Acceptance criteria differ from the captured GitHub issue.']
    gaps = []
    for i, row in enumerate(rows, 1):
        test = row.get('test', '')
        path = (ROOT / test).resolve()
        if not test or not path.is_relative_to(ROOT) or not path.is_file():
            gaps.append(f'AC{i}: test must reference an existing repo file.')
        if not row.get('assertion', '').strip():
            gaps.append(f'AC{i}: describe the observable assertion and scenario.')
    return gaps


def run_check(argv, cwd, timeout, log):
    print(f'  {shlex.join(argv)} ({cwd.relative_to(ROOT)})', flush=True)
    started = time.monotonic()
    with log.open('w') as output:
        process = subprocess.Popen(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    print(f'  exit={code}; {time.monotonic() - started:.1f}s; {log.relative_to(ROOT)}', flush=True)
    if code:
        print(log.read_text(errors='replace')[-6000:])
    return code


def check(args):
    current = task()
    config = read_json(ROOT / 'harness.json')
    mode = 'quick' if args.quick else 'full'
    names = list(config['profiles'][mode])
    if mode == 'full':
        acceptance = config['tickets'].get(current['ticket'])
        if not acceptance:
            raise ValueError(f"No acceptance checks configured for {current['ticket']} in harness.json. Prior-ticket regression checks do not prove this ticket.")
        gaps = proof_gaps(current)
        if gaps:
            raise ValueError('\n'.join(gaps))
        names = list(dict.fromkeys(names + acceptance))
    for name in names:
        command = config['checks'][name]
        if not command['argv'] or not all(isinstance(arg, str) for arg in command['argv']):
            raise ValueError(f'{name}: argv must be a nonempty string array.')
        if not (ROOT / command['cwd']).resolve().is_relative_to(ROOT):
            raise ValueError(f'{name}: cwd must be inside the repository.')
    run_id = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    folder = STATE / 'runs' / run_id
    folder.mkdir(parents=True)
    report = {'mode': mode, 'status': 'RUNNING', 'head': git('rev-parse', 'HEAD'),
              'base': current['base'], 'input_hash': input_hash(), 'checks': []}
    latest = STATE / f'{mode}.json'
    write_json(latest, report)  # Invalidate previous success before executing.
    try:
        whitespace = run_check(['git', 'diff', '--check', current['base']], ROOT, 30, folder / 'diff.log')
        if whitespace:
            raise ValueError('Diff whitespace check failed.')
        for i, name in enumerate(names):
            command = config['checks'][name]
            log = folder / f'{i + 1:02}-{name}.log'
            code = run_check(command['argv'], (ROOT / command['cwd']).resolve(), command['timeout'], log)
            report['checks'].append({'name': name, 'argv': command['argv'], 'cwd': command['cwd'],
                                     'exit_code': code, 'log': str(log.relative_to(ROOT)),
                                     'log_sha256': digest(log.read_bytes())})
            if code:
                raise ValueError(f'{name} failed; fix it and rerun.')
        if input_hash() != report['input_hash']:
            raise ValueError('Source/spec/task changed during checks; results are stale. Rerun on stable inputs.')
        report['status'] = 'PASSED'
    except BaseException as error:
        report['status'] = 'FAILED'
        report['error'] = str(error) or type(error).__name__
        raise
    finally:
        write_json(folder / 'result.json', report)
        write_json(latest, report)
    print(f'{mode.upper()} checks PASSED. This is command evidence, not acceptance or review approval.')


def status():
    current = task()
    print(f"{current['ticket']} | base {current['base']}")
    identity = input_hash()
    for mode in ('quick', 'full'):
        path = STATE / f'{mode}.json'
        report = read_json(path) if path.exists() else {}
        state = report.get('status', 'NOT RUN')
        if report and report.get('input_hash') != identity:
            state = 'STALE'
        print(f'{mode}: {state}')
    gaps = proof_gaps(current)
    print(f'AC mapping: {len(gaps)} gaps. Independent Standards/Spec review still required.')


def review():
    current = task()
    path = STATE / 'full.json'
    report = read_json(path) if path.exists() else {}
    if report.get('status') != 'PASSED' or report.get('input_hash') != input_hash():
        raise ValueError('Run full checks on current inputs before preparing review.')
    for item in report['checks']:
        log = ROOT / item['log']
        if not log.is_file() or digest(log.read_bytes()) != item['log_sha256']:
            raise ValueError(f"Evidence log missing/changed: {item['log']}. Rerun full checks.")
    gaps = proof_gaps(current)
    if gaps:
        raise ValueError('\n'.join(gaps))
    diff = subprocess.check_output(['git', 'diff', '--binary', current['base']], cwd=ROOT)
    (STATE / 'review.diff').write_bytes(diff)
    untracked = git('ls-files', '--others', '--exclude-standard')
    lines = [f"# Review {current['ticket']}", f"Spec: {current['issue_url']}",
             f"Pinned base: `{current['base']}`", f"Current HEAD: `{git('rev-parse', 'HEAD')}`",
             f"Verified input SHA256: `{report['input_hash']}`", '',
             'Run python3 scripts/harness.py status first; stale/missing/failed checks invalidate this packet.',
             'Read .harness/spec.md, .harness/task.json, .harness/review.diff and the actual test assertions.',
             'Untracked files are outside git diff; inspect them too:', '```', untracked or '(none)', '```', '',
             '## Standards review',
             'Check docs/SPEC.md Testing Decisions and relevant ADRs. Identify misleading evidence, tests that cannot detect the bug, and concrete maintainability problems.', '',
             '## Spec review',
             'Check every captured AC against code and observable assertions. Try failure paths, initialization, dynamic/restored IDs, rejected saves, and UI actions.',
             'For each finding give priority, file/line, reproduction and impact. Report zero explicitly per axis when appropriate.', '',
             'Do not treat exit code 0, filled AC fields, or the implementation summary as proof of complete coverage.',
             'Use a fresh review context; this command prepares evidence and does not invoke or impersonate a reviewer.', '',
             '## Executed checks']
    lines.extend(f"- {item['name']}: exit {item['exit_code']}; `{item['log']}`" for item in report['checks'])
    (STATE / 'review.md').write_text('\n'.join(lines) + '\n')
    print('Review packet: .harness/review.md\nPass it to an independent reviewer; implementation is not automatically approved.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('start', help='Capture a GitHub ticket and pin its review baseline')
    prepare.add_argument('ticket', help='Local ticket ID, e.g. T04')
    prepare.add_argument('--base', required=True, help='Branch/commit before this work, e.g. main')
    checks = commands.add_parser('check', help='Run full checks (default), or quick checks while editing')
    checks.add_argument('--quick', action='store_true')
    commands.add_parser('status', help='Show missing/stale/current command evidence')
    commands.add_parser('review', help='Prepare a review packet after current full checks pass')
    args = parser.parse_args()
    try:
        if args.command == 'start':
            start(args)
        elif args.command == 'check':
            STATE.mkdir(exist_ok=True)
            with (STATE / 'check.lock').open('w') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError('Another harness check is running. Wait for it to finish.')
                check(args)
        elif args.command == 'status':
            status()
        else:
            review()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(f'HARNESS BLOCKED: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('HARNESS INTERRUPTED: no passing evidence recorded.', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())
