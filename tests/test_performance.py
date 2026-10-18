import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('benchmark', Path(__file__).resolve().parents[1] / 'scripts/test-performance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    for name in ('reference', 'candidate', 'cache', 'bin'):
        (root/name).mkdir()
    inventory = root/'inventory.json'
    inventory.write_text(json.dumps({'defaultWorkloadInventory': {'currentPhases': {'one': ['only']}}}))
    make = root/'bin/make'
    make.write_text('#!/bin/sh\nprintf "%s\\n" "[test-timing] target=only event=end time=1 duration=0.1s code=0 status=passed" "[test-timing] target=profile-compiler-fingerprint event=end time=1 duration=0.1s code=0 status=passed"\n')
    make.chmod(0o755)
    def run(output):
        argv = ['benchmark', '--reference', str(root/'reference'), '--candidate', str(root/'candidate'),
                '--package-cache', str(root/'cache'), '--inventory', str(inventory), '--output', str(output)]
        with patch.object(sys, 'argv', argv), patch.object(m, 'source_identity', return_value='fixture'), \
             patch.object(m, 'competing_make', return_value=[]), patch.object(m, 'external_cpu', return_value=0), patch.object(m.os, 'getloadavg', return_value=(0,0,0)), \
             patch.object(m.time, 'sleep'), patch.dict(os.environ, {'PATH': str(root/'bin')+':'+os.environ['PATH']}):
            return m.main()
    passed = root/'passed.json'
    assert run(passed) == 0
    result = json.loads(passed.read_text())
    assert result['status'] == 'complete'
    assert len(result['samples']) == 10
    assert [row['variant'] for row in result['samples']][:4] == ['reference','candidate','candidate','reference']
    make.write_text('#!/bin/sh\nexit 2\n')
    failed = root/'failed.json'
    assert run(failed) == 1
    result = json.loads(failed.read_text())
    assert result['status'] == 'incomplete'
    assert len(result['samples']) == 1 and result['samples'][0]['exitCode'] == 2
    assert 'comparison' not in result
    make.write_text('#!/bin/sh\nexit 0\n')
    missing = root/'missing.json'
    assert run(missing) == 1
    result = json.loads(missing.read_text())
    assert result['samples'][0]['missingOrFailedTargets'] == ['only','profile-compiler-fingerprint']
    inventory.write_text(json.dumps({'defaultWorkloadInventory': {'currentPhases': {}}}))
    empty = root/'empty.json'
    try:
        run(empty)
    except SystemExit as error:
        assert error.code == 2
    else:
        raise AssertionError('empty workload inventory was accepted')
    assert not empty.exists(), 'invalid inventory must fail before starting evidence collection'
print('Benchmark orchestration: PASS (including failed/missing targets and empty inventory; fake make only)')
