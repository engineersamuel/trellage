import { isGraphOfLoopsProfile, type GraphOfLoopsProfile, type Profile } from "./profile.js"

export interface GraphOfLoopsPolicy {
  readonly schema: 1
  readonly profile: string
  readonly gateway: string
  readonly runtime_integrity: string
  readonly components: {
    readonly tracker: "beads"
    readonly scheduler: "bernstein"
    readonly worktree_backend: "bernstein"
    readonly node_runtime: "waku"
  }
  readonly models: {
    readonly supervisor: string
    readonly specialist: string
    readonly reviewer: string
  }
  readonly limits: {
    readonly max_parallel_nodes: number
    readonly max_node_iterations: number
    readonly max_specialist_attempts: number
    readonly max_gate_calls: number
    readonly max_supervisor_tokens: number
    readonly node_timeout_seconds: number
  }
  readonly roles: GraphOfLoopsProfile["orchestration"]["roles"]
  readonly review: GraphOfLoopsProfile["orchestration"]["review"]
  readonly proof: GraphOfLoopsProfile["orchestration"]["proof"]
  readonly authorization: GraphOfLoopsProfile["orchestration"]["authorization"]
  readonly paths: {
    readonly claude_mcp: "/usr/local/share/trellage/claude-mcp.json"
    readonly codex_config: "/usr/local/share/trellage/codex-reviewer-config.toml"
    readonly runtime: "/opt/trellage/graph-of-loops"
  }
}

export const graphOfLoopsPolicy = (profile: Profile, runtimeIntegrity: string): GraphOfLoopsPolicy | undefined => {
  if (!isGraphOfLoopsProfile(profile)) return undefined
  const orchestration = profile.orchestration
  return {
    schema: 1,
    profile: profile.name,
    gateway: profile.harness.claude.gateway,
    runtime_integrity: runtimeIntegrity,
    components: {
      tracker: orchestration.tracker,
      scheduler: orchestration.scheduler,
      worktree_backend: orchestration.worktree_backend,
      node_runtime: orchestration.node_runtime,
    },
    models: {
      supervisor: orchestration.supervisor_model,
      specialist: profile.harness.claude.model,
      reviewer: orchestration.review.model,
    },
    limits: {
      max_parallel_nodes: orchestration.max_parallel_nodes,
      max_node_iterations: orchestration.max_node_iterations,
      max_specialist_attempts: orchestration.max_specialist_attempts,
      max_gate_calls: orchestration.max_gate_calls,
      max_supervisor_tokens: orchestration.max_supervisor_tokens,
      node_timeout_seconds: orchestration.node_timeout_seconds,
    },
    roles: orchestration.roles,
    review: orchestration.review,
    proof: orchestration.proof,
    authorization: orchestration.authorization,
    paths: {
      claude_mcp: "/usr/local/share/trellage/claude-mcp.json",
      codex_config: "/usr/local/share/trellage/codex-reviewer-config.toml",
      runtime: "/opt/trellage/graph-of-loops",
    },
  }
}

export const renderGraphOfLoopsPolicy = (profile: Profile, runtimeIntegrity: string): string | undefined => {
  const policy = graphOfLoopsPolicy(profile, runtimeIntegrity)
  return policy === undefined ? undefined : `${JSON.stringify(policy, null, 2)}\n`
}
