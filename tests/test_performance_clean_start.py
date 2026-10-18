import importlib.util
import json
import os
from pathlib import Path
import subprocess
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
    for name in ('reference', 'candidate'):
        source = root/name
        def git(*args):
            subprocess.run(['git',*args],cwd=source,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        git('init')
        (source/'.gitignore').write_text('node_modules/\n')
        (source/'scripts').mkdir()
        (source/'scripts/test-offline.py').write_text('import os,sys\nassert sys.argv[1]=="--"\nos.execvp(sys.argv[2],sys.argv[2:])\n')
        (source/'scripts/install-source-runtime.sh').write_text('#!/bin/sh\n[ "$1" = --prepare ] || exit 2\nmkdir -p node_modules\n')
        git('add','.')
        git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','fixture')
    for name,body in {
        'mise':'[ "$1" = trust ] || exit 2',
        'npm':'[ "$*" = "--prefix tests/playwright ci --offline --no-audit --no-fund" ] || exit 2',
        'make':'[ -d node_modules ] || exit 2\nprintf "%s\\n" "[test-timing] target=only event=end time=1 duration=0.1s code=0 status=passed" "[test-timing] target=profile-compiler-fingerprint event=end time=1 duration=0.1s code=0 status=passed"',
    }.items():
        executable=root/'bin'/name
        executable.write_text('#!/bin/sh\n'+body+'\n')
        executable.chmod(0o755)
    inventory=root/'inventory.json'
    inventory.write_text(json.dumps({'defaultWorkloadInventory':{'currentPhases':{'one':['only']}}}))
    output=root/'result.json'
    argv=['benchmark','--reference',str(root/'reference'),'--candidate',str(root/'candidate'),
          '--package-cache',str(root/'cache'),'--inventory',str(inventory),'--output',str(output),
          '--phase','clean-start','--pairs','1']
    with patch.object(sys,'argv',argv),patch.object(m,'competing_make',return_value=[]),patch.object(m,'external_cpu',return_value=0), \
         patch.object(m.os,'getloadavg',return_value=(0,0,0)),patch.object(m.time,'sleep'), \
         patch.dict(os.environ,{'PATH':str(root/'bin')+':'+os.environ['PATH']}):
        assert m.main()==0
    report=json.loads(output.read_text())
    assert report['status']=='complete' and report['phase']=='clean-start'
    assert len(report['samples'])==2 and len(report['preparations'])==2
    assert all(p['status']=='passed' and p['includedInTestTiming'] is False for p in report['preparations'])
    assert all(s['sourceUnchanged'] for s in report['samples'])
    assert 'comparison' not in report and set(report['distributions'])=={'reference','candidate'}
    assert not(root/'reference/node_modules').exists() and not(root/'candidate/node_modules').exists()
print('Clean-start orchestration PASS: fresh source trees, preparation before tests, separate timing records, original trees unchanged; fake tools only, not performance evidence')
