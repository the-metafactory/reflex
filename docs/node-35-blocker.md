# Node #35: released myelin contract missing

Status: blocked at the dependency precondition, checked 2026-10-13.

## Review round 1: PR metadata correction required

The PR title "Release reflex run locks on execution.run.finished instead
of pulse.run.*" describes a runtime change this branch does not implement.
The supervisor must replace it with:

> Document missing released myelin A5b contract for node #35

The PR description must identify this diff as a blocker report and state
that the runtime change, acceptance scenarios, and checkpoint
`mfp-reflex-run-lock-on-run-finished` remain undelivered. Passing baseline
tests does not verify those acceptance scenarios. This report must not be
treated as delivery of node #35.

The implement worker cannot change PR metadata under the task/build SOP.
The title finding remains unresolved until the supervisor makes that
correction; this document supplies the exact replacement and scope.

## Dependency evidence

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

The review-round recheck also queried all published version tags:

```sh
rtk proxy git ls-remote https://github.com/the-metafactory/myelin.git 'refs/tags/v*'
```

The newer published releases still have no execution-run-finished exports
in their `src/edge.ts`. Their release commits were inspected in the sibling
checkout and matched against the remote tag results (peeled for the
annotated `v0.7.0` tag):

| Release | Commit | Required `/edge` exports |
| --- | --- | --- |
| `v0.6.0` | `a69ecd7d760434fd5e2f27b2e3de3b3bcd510be1` | absent |
| `v0.7.0` | `c534a0b9ea66066d5fe2731c2dc62a27561a9e56` | absent |
| `v0.7.1` | `0c29c2272c99740c67c81d6a6609cab620b41473` | absent |
| `v0.8.0` | `d4262007a3d425132de56842e0b49a10d64b55be` | absent |

For each release, the source probe was:

```sh
rtk proxy git -C /Users/fischer/work/ranger-repos/the-metafactory/myelin show <release>:src/edge.ts
```

No later version tag was returned by the remote query. There is still no
released A5b contract to pin; an unreleased sibling checkout is not a
substitute for the node's required release.

## Review-round verification

The required full command `bun run test && bun run typecheck` was run once.
Tests reported **283 pass, 2 skip, 1 fail**. The existing
`test/activation/watcher.test.ts` test "keeps the last good set when an
invalid file is written" observed `lastError() === null` after its fixed
400 ms wait; the reload error appeared afterward. The test's watcher has
a 2000 ms safety-net rescan because filesystem events can be missed.
No watcher source or tests changed in this report-only diff.

The failed command did not reach typecheck. Follow-up verification:

- `bun test test/activation/watcher.test.ts`: **5 pass, 0 fail**.
- `bun run typecheck`: **passed**.
- `git diff --check`: **passed**.

The isolated pass supports a timing-flake diagnosis, but does not turn
the full run green. The full suite was not repeated under the worker's
once-only rule. The supervisor still needs a passing full run before
pushing; none of these baseline checks verifies node #35's unimplemented
acceptance scenarios.

## Supervisor escalation

Correct the PR title and description as above before another review.
Release A5b in a myelin tag whose `/edge` entry exports all three functions,
then resume node #35 against the first release containing that contract.
Do not close the node through checkpoint `mfp-reflex-run-lock-on-run-finished`
on the strength of this report: the runtime change and acceptance scenarios
remain unimplemented.

This report is the worker's escalation artifact for the supervisor. No graph
node or map was edited. NATS subscription permissions were not exercised;
the dependency precondition failed before implementation.
