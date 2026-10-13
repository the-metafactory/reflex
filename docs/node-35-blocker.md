# Node #35: released myelin contract missing

Status: blocked at the dependency precondition, checked 2026-10-13.

The node requires `executionRunFinishedSubject`,
`validateExecutionRunFinished`, and `createExecutionRunFinished` from
`@the-metafactory/myelin/edge`. Its brief requires stopping and escalating
if any of these exports is missing.

`package.json` already pins myelin to `#v0.6.0`. `bun.lock` resolves it to
`a69ecd7`, and the installed package reports version `0.6.0`. The remote
tag confirms the same commit:

```sh
rtk proxy git ls-remote https://github.com/the-metafactory/myelin.git refs/tags/v0.6.0
```

```text
a69ecd7d760434fd5e2f27b2e3de3b3bcd510be1 refs/tags/v0.6.0
```

The installed `/edge` namespace has none of the required exports:

```sh
rtk proxy bun -e 'import * as edge from "@the-metafactory/myelin/edge"; for (const name of ["executionRunFinishedSubject", "validateExecutionRunFinished", "createExecutionRunFinished"]) console.log(name + ": " + typeof edge[name]);'
```

```text
executionRunFinishedSubject: undefined
validateExecutionRunFinished: undefined
createExecutionRunFinished: undefined
```

Inspecting `src/edge.ts` at the release tag in the sibling myelin checkout
also shows none of these exports. The sibling checkout contains the
execution-run-finished implementation introduced by commit `277ad3b`,
but the pinned release does not expose it.

## Supervisor escalation

Release A5b in a myelin tag whose `/edge` entry exports all three functions,
then resume node #35 against the first release containing that contract.
Do not close the node through checkpoint `mfp-reflex-run-lock-on-run-finished`
on the strength of this report: the runtime change and acceptance scenarios
remain unimplemented.

This report is the worker's escalation artifact for the supervisor. No graph
node or map was edited. NATS subscription permissions were not exercised;
the dependency precondition failed before implementation.
