#!/usr/bin/env python3
"""Record serial matched warm make-test samples; never turn failures into timings."""
from __future__ import annotations

import argparse
import importlib.util
import signal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time


def distribution(samples: list[float]) -> dict[str, float]:
    if not samples or any(not math.isfinite(value) or value <= 0 for value in samples):
        raise ValueError('positive elapsed samples required')
    median = statistics.median(samples)
    return {'median': median, 'mad': statistics.median(abs(value - median) for value in samples)}


def compare(reference: list[float], candidate: list[float]) -> dict:
    if len(reference) != len(candidate) or len(reference) < 5:
        raise ValueError('at least five matched pairs required')
    a, b = distribution(reference), distribution(candidate)
    improvement = a['median'] - b['median']
    threshold = max(0.05 * a['median'], 3 * max(a['mad'], b['mad']))
    return {'reference': a, 'candidate': b, 'improvementSeconds': improvement,
            'thresholdSeconds': threshold, 'accepted': improvement > threshold,
            'reason': 'improvement exceeds both 5% reference median and 3 times larger MAD'
                      if improvement > threshold else 'improvement does not exceed the declared noise threshold'}


def source_identity(root: Path) -> str:
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root)
    digest = hashlib.sha256()
    for name in sorted(set(paths.split(b'\0')) - {b'', b'test-performance.json'}):
        item = root / os.fsdecode(name)
        digest.update(name + b'\0')
        if item.is_symlink():
            digest.update(b'link\0' + os.fsencode(os.readlink(item)))
        elif item.is_file():
            digest.update(str(item.stat().st_mode & 0o7777).encode() + b'\0')
            with item.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
        else:
            digest.update(b'missing')
        digest.update(b'\0')
    return digest.hexdigest()


def competing_make(owned_pid: int | None = None) -> list[str]:
    processes = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,comm=,args='], text=True)
    rows = [line.split(None, 3) for line in processes.splitlines()]
    owned = {owned_pid} if owned_pid is not None else set()
    changed = True
    while changed:
        before = len(owned)
        owned.update(int(row[0]) for row in rows if len(row) >= 3 and int(row[1]) in owned)
        changed = len(owned) != before
    return [' '.join(row) for row in rows if len(row) >= 3
            and int(row[0]) not in owned and Path(row[2]).name in ('make', 'gmake')]


def external_cpu() -> float:
    rows = [line.split(None, 3) for line in subprocess.check_output(
        ['ps', '-axo', 'pid=,ppid=,pcpu=,comm='], text=True).splitlines()]
    owned = {os.getpid()}
    while True:
        before = len(owned)
        owned.update(int(row[0]) for row in rows if len(row) == 4 and int(row[1]) in owned)
        if len(owned) == before:
            break
    return sum(float(row[2]) for row in rows if len(row) == 4 and int(row[0]) not in owned)


def wait_for_quiet(maximum_load: float, maximum_external_cpu: float, timeout: float) -> dict:
    started = time.monotonic()
    while True:
        competition = competing_make()
        if competition:
            raise RuntimeError('other make jobs are active: ' + '; '.join(competition))
        load, cpu = os.getloadavg(), external_cpu()
        waited = time.monotonic() - started
        if load[0] <= maximum_load and cpu <= maximum_external_cpu:
            return {'waitSeconds':waited,'load':load,'externalCpuPercent':cpu}
        if waited >= timeout:
            raise RuntimeError(f'host did not become quiet within {timeout}s: load={load[0]}, external CPU={cpu}')
        time.sleep(1)


def target_evidence(text: str, expected: set[str]) -> tuple[list[dict], list[str]]:
    rows = [match.groupdict() for match in re.finditer(
        r'^\[test-timing\] target=(?P<target>\S+) event=end time=\S+ duration=(?P<seconds>[\d.]+)s code=(?P<code>\d+) status=(?P<status>\w+)$', text, re.MULTILINE)]
    missing = expected - {row['target'] for row in rows}
    failures = [row['target'] for row in rows if row['code'] != '0' or row['status'] != 'passed']
    return rows, sorted(missing) + failures


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--package-cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True, help='test-performance report containing currentPhases')
    parser.add_argument('--pairs', type=int, default=5)
    parser.add_argument('--phase', choices=['warm', 'clean-start'], default='warm')
    parser.add_argument('--max-load', type=float, default=float(os.cpu_count() or 1),
                        help='Maximum in-run load, including this suite; contention is also checked separately')
    parser.add_argument('--max-start-load', type=float, default=max(1.0, (os.cpu_count() or 1) / 4),
                        help='Maximum one-minute host load before each serial sample')
    parser.add_argument('--max-external-cpu', type=float, default=100.0,
                        help='Maximum total CPU percentage outside the benchmark process tree (100 = one core)')
    parser.add_argument('--quiet-timeout', type=float, default=300.0)
    args = parser.parse_args()
    for name in ('max_load','max_start_load','max_external_cpu','quiet_timeout'):
        if not math.isfinite(getattr(args,name)) or getattr(args,name) <= 0:
            parser.error(f'{name} must be positive and finite')
    if args.phase == 'warm' and args.pairs < 5:
        parser.error('at least five pairs required')
    if args.pairs < 1:
        parser.error('at least one pair required')
    if args.output.exists():
        parser.error('output must be new; previous raw evidence is never overwritten')
    roots = {'reference': args.reference.resolve(), 'candidate': args.candidate.resolve()}
    if roots['reference'] == roots['candidate']:
        parser.error('reference and candidate must be distinct')
    cache = args.package_cache.resolve()
    if not cache.is_dir():
        parser.error('prepare a shared package cache before benchmarking')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    phases = json.loads(args.inventory.read_text())['defaultWorkloadInventory']['currentPhases']
    expected = {target for targets in phases.values() for target in targets}
    if not expected:
        parser.error('expected target inventory is empty')
    expected.add('profile-compiler-fingerprint')
    identities = {name: source_identity(root) for name, root in roots.items()}
    report = {'phase': args.phase, 'status': 'running', 'command': ['make', 'test'],
              'sources': {name: {'path': str(root), 'sha256': identities[name]} for name, root in roots.items()},
              'environment': {'packageCache': str(cache), 'PATH': os.environ.get('PATH', ''),
                              'python': sys.executable, 'maxLoad': args.max_load,
                              'maxStartLoad': args.max_start_load,'maxExternalCpuPercent':args.max_external_cpu,
                              'quietTimeoutSeconds':args.quiet_timeout},
              'samples': [], 'preparations': [], 'pairs': args.pairs, 'expectedTargets': sorted(expected),
              'protocol': 'Fresh make/test processes; installed dependencies and shared package bytes retained. All default tests rerun. AB then BA alternating pair order. Clean-start evidence is separate.'}
    atomic_json(args.output, report)
    env = dict(os.environ, TRELLAGE_TEST_PACKAGE_CACHE=str(cache))
    result = None
    def interrupted(signum, frame):
        if result is not None and result.poll() is None:
            os.killpg(result.pid, signum)
        raise KeyboardInterrupt(f'interrupted by signal {signum}')
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        for pair in range(args.pairs):
            for name in (['reference', 'candidate'] if pair % 2 == 0 else ['candidate', 'reference']):
                quiet = wait_for_quiet(args.max_start_load,args.max_external_cpu,args.quiet_timeout)
                load = quiet['load']
                root = roots[name]
                if source_identity(root) != identities[name]:
                    raise RuntimeError(f'{name} source changed before measurement')
                if args.phase == 'clean-start':
                    module_path = Path(__file__).with_name('test-performance-snapshot.py')
                    spec = importlib.util.spec_from_file_location('clean_snapshot', module_path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    destination = args.output.parent / f'{args.output.stem}-{pair:02d}-{name}-clean'
                    receipt = module.snapshot(root, destination)
                    root = destination.resolve()
                    subprocess.run(['mise', 'trust'], cwd=root, check=True, stdout=subprocess.DEVNULL)
                    prepare_log = args.output.with_name(f'{args.output.stem}-{pair:02d}-{name}-prepare.log')
                    preparation = time.monotonic()
                    preparation_record = {**receipt,'status':'running','log':str(prepare_log),
                                          'includedInTestTiming':False}
                    report['preparations'].append(preparation_record)
                    atomic_json(args.output, report)
                    try:
                        with prepare_log.open('xb') as stream:
                            prepare_env = dict(env, BUN_INSTALL_CACHE_DIR=str(cache))
                            for command in [
                                ['bash', 'scripts/install-source-runtime.sh', '--prepare'],
                                ['npm', '--prefix', 'tests/playwright', 'ci', '--offline', '--no-audit', '--no-fund'],
                            ]:
                                result = subprocess.Popen([sys.executable, 'scripts/test-offline.py', '--', *command],
                                                          cwd=root, env=prepare_env, stdout=stream,
                                                          stderr=subprocess.STDOUT, start_new_session=True)
                                if result.wait() != 0:
                                    raise RuntimeError(f'clean-start preparation failed: {command}; see {prepare_log}')
                        preparation_record['status'] = 'passed'
                    finally:
                        preparation_record['elapsedSeconds'] = time.monotonic() - preparation
                        if preparation_record['status'] == 'running':
                            preparation_record['status'] = 'failed-or-interrupted'
                        atomic_json(args.output, report)
                    if source_identity(root) != identities[name]:
                        raise RuntimeError('clean-start preparation changed source inventory')
                    quiet = wait_for_quiet(args.max_start_load,args.max_external_cpu,args.quiet_timeout)
                    load = quiet['load']
                log = args.output.with_name(f'{args.output.stem}-{pair:02d}-{name}.log')
                started = time.monotonic()
                wall_started = time.time()
                last_poll = started
                contamination = []
                with log.open('xb') as stream:
                    result = subprocess.Popen(['make', 'test'], cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                    while result.poll() is None:
                        now = time.monotonic()
                        wall_drift = abs((time.time() - wall_started) - (now - started))
                        if now - last_poll > 10 or wall_drift > 2:
                            contamination.append({'elapsedSeconds': now - started,
                                                  'pollGapSeconds': now - last_poll,
                                                  'wallMonotonicDriftSeconds': wall_drift})
                        last_poll = now
                        external = competing_make(result.pid)
                        external_percent = external_cpu()
                        current_load = os.getloadavg()[0]
                        if external or current_load > args.max_load or external_percent > args.max_external_cpu:
                            contamination.append({'elapsedSeconds': time.monotonic() - started,
                                                  'externalMake': external, 'load': current_load,
                                                  'externalCpuPercent':external_percent})
                        time.sleep(1)

                elapsed = time.monotonic() - started
                unchanged = source_identity(root) == identities[name]
                text = log.read_text(errors='replace')
                targets, invalid_targets = target_evidence(text, expected)
                sample = {'pair': pair, 'variant': name, 'elapsedSeconds': elapsed, 'exitCode': result.returncode,
                          'sourceUnchanged': unchanged, 'loadBefore': load, 'loadAfter': os.getloadavg(),
                          'quietBefore':quiet,
                          'log': str(log), 'targets': targets, 'contamination': contamination, 'missingOrFailedTargets': invalid_targets}
                report['samples'].append(sample)
                atomic_json(args.output, report)
                if result.returncode != 0 or not unchanged or contamination or invalid_targets:
                    raise RuntimeError(f'{name} failed, omitted target evidence, changed, or had host contention; raw sample retained but no performance acceptance')
        samples = [[row['elapsedSeconds'] for row in report['samples'] if row['variant'] == name]
                   for name in ('reference', 'candidate')]
        if args.phase == 'warm':
            report['comparison'] = compare(*samples)
        else:
            report['distributions'] = dict(zip(('reference','candidate'),map(distribution,samples)))
            report['protocol'] = ('First test run in each fresh source snapshot, after separately timed frozen '
                                  'dependency preparation. No previous test processes or ignored fixture/transpiler '
                                  'caches. Shared package bytes and OS caches remain warm; NOT dependency-cold or '
                                  'machine-cold. Never included in warm speedup acceptance.')
        report['status'] = 'complete'
    except (Exception, KeyboardInterrupt) as error:
        if result is not None and result.poll() is None:
            os.killpg(result.pid, signal.SIGTERM)
            try:
                result.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(result.pid, signal.SIGKILL)
                result.wait()
        report['status'] = 'incomplete'
        report['failure'] = str(error)
        atomic_json(args.output, report)
        print(str(error), file=sys.stderr)
        return 1
    atomic_json(args.output, report)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
