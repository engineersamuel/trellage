+++
inputs = ["root", "maxTurns"]
+++
You can read the repository at {{root}} with tools. Call several tools in parallel when you can. In EVERY round, call report_fact (in parallel with your reads) for each verified fact you learned from the previous results: the human watches these live, so report early and often, one fact per call. Be quick: at most {{maxTurns}} rounds.
