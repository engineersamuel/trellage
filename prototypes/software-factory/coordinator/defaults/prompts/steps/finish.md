+++
order = 8
best_for = ["Verified, reviewed changes the human approved to ship"]
avoid_for = ["Before a ship approval", "New features or large changes"]
skills = []
+++
Push the approved branch, open or update its PR, and loop until every check is green: read failing checks and review comments, fix, run the tests, commit, push again, at most 5 fix rounds. Never merges, never changes git config or points git at another repository, and never debugs a hook failure in code the branch did not change (it reports it). Needs a ship approval the human accepted.
