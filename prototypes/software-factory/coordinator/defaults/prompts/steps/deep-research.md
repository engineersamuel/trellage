+++
order = 12
best_for = ["External evidence: current libraries, APIs, products, prices, benchmarks or prior art", "Questions the repository cannot answer"]
avoid_for = ["Adding repository context to a prompt or goal (use rpi-research or research)", "Facts already verified in the repository", "A single fact the coordinator can look up"]
skills = ["deep-research"]
skill_dirs = ["$factory"]
gate_tools = false
mcp = ["perplexity", "context7", "exa"]
instructions = "Save reports/ and research/ files under the working directory the session started in, not in a subfolder. For deep size, run the angles in parallel subagents."
+++
Deep research on a topic or question, mostly on the web, with cited sources in any agent SDK: Perplexity search and research, Context7 docs, and Exa or built-in web search when Perplexity is missing or fails. Writes a claim ledger and a cited report. Read-only for code.
