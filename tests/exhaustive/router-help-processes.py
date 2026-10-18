import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

root=Path(__file__).resolve().parents[2]
if os.environ.get('TRELLAGE_TEST_OFFLINE') != '1':
    raise RuntimeError('Run through scripts/test-offline.py to enforce offline execution')
router=root/'prototypes/trellage-router/bin/trx'
cases=[]
for alias in ['-h','--help','help']:
    for suffix in [[],['run'],['guide'],['--unknown']]:
        cases.append({'argv':[alias,*suffix],'status':0,'contains':'Usage:'})
    for suffix in [[],['codex','superpowers'],['--dry-run','--require-proven-isolation']]:
        cases.append({'argv':['run',alias,*suffix],'status':0,'contains':'trx run'})
    cases.append({'argv':['guide',alias],'status':0,'contains':'guide'})
cases.append({'argv':['run','unknown-harness'],'status':1,'contains':'unknown harness'})
results=[]
try:
    with tempfile.TemporaryDirectory(prefix='router-help-') as home:
        env={key:os.environ[key] for key in ['PATH','TRELLAGE_TEST_OFFLINE','TRELLAGE_TEST_VIOLATIONS','TRELLAGE_TEST_BUN','TRELLAGE_TEST_BIN'] if key in os.environ}
        env.update(HOME=home,TRELLAGE_TRX_SOURCE_ROOT=str(router.parent.parent),TRELLAGE_TRX_NATIVE_SOURCE='1')
        for ordinal,case in enumerate(cases):
            child=subprocess.run(['bash',str(router),*case['argv']],cwd=root,env=env,
                                 input='',capture_output=True,text=True,start_new_session=True,timeout=30)
            row={'id':f'router-help:{ordinal}',**case,'actualStatus':child.returncode,
                 'stdout':child.stdout,'stderr':child.stderr}
            results.append(row)
            assert child.returncode==case['status'],row
            assert case['contains'].lower() in (child.stdout+child.stderr).lower(),row
finally:
    print(json.dumps({
        'scope':'Actual Bash router help aliases, early dispatch with trailing operands, unknown harness, detached non-TTY processes; NOT complete process-sensitive matrix',
        'routerSha256':hashlib.sha256(router.read_bytes()).hexdigest(),
        'declared':len(cases),'executed':len(results),'results':results,
    },separators=(',',':')))
print(f'Router help process cases: {len(results)} passed')
