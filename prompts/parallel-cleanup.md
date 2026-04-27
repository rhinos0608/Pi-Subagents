---
description: Parallel subagents cleanup
---

Launch parallel reviewers for an adversarial review of the current work.

One reviewer should load with the deslop skill and another reviewer with the verbosity check skill.

Give every reviewer a meta prompt. Ask reviewers to return concise, evidence-backed findings with file/line references and suggested fixes. The response should be review feedback, not a context summary. Reviewers must not edit files unless I explicitly ask for a writer pass.

While the reviewers run, do your own narrow inspection if useful. After they return, synthesize the feedback into:
- fixes worth doing now
- optional improvements
- feedback to ignore or defer, with a short reason

Do not blindly apply every reviewer suggestion. Ask before applying fixes unless I already told you to address review feedback.

$@
