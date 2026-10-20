import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  PRIME_PROFILE_MARKER,
  primeRuntimePaths,
} from "../../packages/trellage-runtime/src/native-run/prime-runtime.ts"

export async function installHostFixtures(root: string, environment: NodeJS.ProcessEnv) {
  const bin = path.join(root, "host-bin")
  await mkdir(bin, { recursive: true })
  const put = async (file: string, body: string, mode = 0o600) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body, { mode })
  }
  const executable = async (name: string, body: string) => {
    const file = path.join(bin, name)
    await put(
      file,
      `#!${process.execPath}\nimport assert from 'node:assert/strict';\nimport {mkdirSync,appendFileSync,existsSync,statSync} from 'node:fs';\nconst args=process.argv.slice(2);\nconst trace=${JSON.stringify(path.join(root, "host-calls.jsonl"))};\nconst line=JSON.stringify({name:${JSON.stringify(name)},args})+'\\n';\nif((existsSync(trace)?statSync(trace).size:0)+Buffer.byteLength(line)<=65536)appendFileSync(trace,line);\n${body}\n`,
      0o700,
    )
    return file
  }
  const leaf = await executable("model-leaf", "throw new Error('Unexpected model execution')")
  environment.PATH = `${bin}:${environment.PATH ?? ""}`
  for (const name of ["jq", "treehouse", "gh-axi", "tasks-axi"])
    await executable(name, "throw new Error('Unexpected prerequisite execution')")
  await executable(
    "gh",
    "assert.deepEqual(args,['auth','token','--hostname','github.com']);console.log('fixture-github-token')",
  )
  environment.TRELLAGE_AGENCY_LIFECYCLE_BIN = await executable(
    "agency",
    "assert.deepEqual(args,['inventory','trellage-azure','--json']);console.log(JSON.stringify({readiness:'healthy',authenticationMethod:'AzureCliCredential'}))",
  )
  environment.TRELLAGE_JCODE_LIFECYCLE_BIN = await executable(
    "jcode",
    `assert.deepEqual(args,['_trx-executable']);assert.equal(process.env.TRELLAGE_TRX_JCODE_ADAPTER,'1');console.log(${JSON.stringify(leaf)})`,
  )
  environment.TRELLAGE_CLAUDE_LIFECYCLE_BIN = await executable(
    "claude",
    "assert.equal(process.env.TRELLAGE_TRX_CLAUDE_ADAPTER,'1');assert.equal(args.length,2);assert.equal(args[0],'_trx-admit');assert.ok(['default','office','office-charts'].includes(args[1]));console.log(JSON.stringify({pluginDir:null}))",
  )
  const overlay = path.join(root, "omp-overlay.yml")
  await put(overlay, "setupVersion: 1\n")
  environment.TRELLAGE_OMP_LIFECYCLE_BIN = await executable(
    "omp",
    `assert.equal(process.env.TRELLAGE_TRX_OMP_ADAPTER,'1');assert.equal(args.length,2);assert.equal(args[0],'_trx-admit');assert.ok(['default','local'].includes(args[1]));console.log(JSON.stringify({schemaVersion:1,executable:${JSON.stringify(leaf)},ompProfile:args[1]==='default'?'trellage-copilot-native':'trellage-qwen-local',piConfigFiles:${JSON.stringify(overlay)},version:'18.8.5',copilotCredentialFile:null}))`,
  )
  const plugins = path.join(root, "host-plugins")
  await mkdir(plugins, { recursive: true })
  environment.TRELLAGE_COPILOT_LIFECYCLE_BIN = await executable(
    "copilot",
    `assert.equal(process.env.TRELLAGE_TRX_COPILOT_ADAPTER,'1');assert.equal(args.length,2);assert.equal(args[0],'_trx-admit');assert.ok(['awesome','compound-engineering','hve','plannotator','superpowers','tufte-vdqi'].includes(args[1]));console.log(JSON.stringify({installedPlugins:${JSON.stringify(plugins)},settings:{},pluginRegistrations:[{cache_path:${JSON.stringify(plugins)}}]}))`,
  )
  environment.TRELLAGE_COPILOT_BIN = await executable(
    "copilot-clean",
    "assert.equal(args[0],'--no-auto-update');assert.deepEqual(args.slice(2),['list','--json']);assert.ok(['skill','mcp'].includes(args[1]));console.log(args[1]==='skill'?'[]':'{\"mcpServers\":{}}')",
  )
  environment.TRELLAGE_CODEX_BIN = await executable(
    "codex-clean",
    `
assert.deepEqual(args.slice(0,-3),['-c','project_doc_max_bytes=0','-c','skills.include_instructions=false','-c','skills.bundled.enabled=false','--enable','skip_host_skill_discovery','--disable','apps','--disable','plugins','--disable','hooks','--disable','memories','-c','check_for_update_on_startup=false']);
assert.equal(args.at(-3),'-c');assert.equal(args.at(-2),'projects.'+JSON.stringify(process.cwd())+'.trust_level="trusted"');assert.equal(args.at(-1),'app-server');
const {createInterface}=await import('node:readline');let state=0;
for await(const line of createInterface({input:process.stdin})){
const message=JSON.parse(line);
if(state===0){assert.equal(message.method,'initialize');assert.equal(message.id,1);assert.ok(message.params.clientInfo);console.log(JSON.stringify({id:1,result:{}}));}
else if(state===1){assert.deepEqual(message,{method:'initialized'});}
else if(state===2){assert.deepEqual(message,{id:2,method:'skills/list',params:{cwds:[process.cwd()],forceReload:true}});console.log(JSON.stringify({id:2,result:{data:[{skills:[]}]}}));}
else throw Error('Unexpected app-server request');state++;
}`,
  )
  environment.TRELLAGE_HEADLONG_HOME = path.join(root, "headlong")
  environment.TRELLAGE_HEADLONG_APP_DIR = path.join(root, "headlong-app")
  environment.TRELLAGE_HEADLONG_INIT_BIN = await executable(
    "headlong-init",
    "assert.deepEqual(args,[]);assert.ok(process.env.HEADLONG_APP_DIR);mkdirSync(process.env.HEADLONG_APP_DIR+'/.identities/ada',{recursive:true})",
  )
  environment.TRELLAGE_PRIME_LIFECYCLE_BIN = await executable("prime", "assert.deepEqual(args,['repair','default'])")
  const prime = primeRuntimePaths({ environment })
  const payloadRoot = path.join(prime.rustPrefix, "share", "prime-agent")
  await mkdir(payloadRoot, { recursive: true })
  await put(path.join(payloadRoot, "package.json"), '{"name":"prime-agent","version":"0.10.0"}\n')
  await put(
    path.join(prime.rustPrefix, "bin", "prime-agent"),
    "#!/bin/sh\n[ \"$*\" = --version ] || { echo 'Unexpected Prime execution' >&2; exit 97; }\necho 0.10.0 >&2\n",
    0o755,
  )
  await put(prime.receiptFile, "0.10.0\n")
  const identity =
    JSON.stringify({
      schemaVersion: 1,
      primeVersion: "0.10.0",
      runtimeHashAlgorithm: "sha256",
      runtimeHash: "a".repeat(64),
      kernelSpecVersion: 1,
    }) + "\n"
  await put(prime.runtimeIdentityFile, identity)
  await mkdir(path.join(prime.profileHome, "extensions"), { recursive: true })
  await put(prime.profileMarker, `${PRIME_PROFILE_MARKER}\n`)
  await put(prime.kernelPython, "#!/bin/sh\necho 'Unexpected kernel execution' >&2\nexit 71\n", 0o700)
  await put(prime.kernelIdentityStamp, identity)
  return { bin, leaf }
}
