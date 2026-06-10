# Tasks: R-107 CLI over NATS Request/Reply

Branch: `spec/r-107-cli` · TDD per task.

## T-1: Protocol + subjects
- CmdRequest/CmdResponse v1, cmdSubject(cfg, command); version-mismatch handling.

## T-2: Daemon command router
- subscribeReplyable per command → handlers + evaluateDry + historyFor + status snapshot (instanceId, counts, metrics, next ticks); wired in startDaemon.

## T-3: CLI client + exit mapping
- short-lived bus request with timeout; transport-vs-domain error split; exit-code map {0,1,2}.

## T-4: Commander program + render
- 9 subcommands, --json everywhere, human tables, canonical output vocabulary, help examples.

## T-5: E2E matrix + gates
- InMemory end-to-end per command; --json JSON.parse matrix; timeout exit-2 path; banned-vocab render audit; live `reflex status` evidence at closeout.

## Done gate
- Spec scenarios 1–6 named; `specflow validate R-107`.
