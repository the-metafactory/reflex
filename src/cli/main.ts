import { Command as Commander, CommanderError, InvalidArgumentError, Option } from "commander";
import { userInfo } from "node:os";
import { validatePaths } from "../activation/validate-cli";
import { createReflexBus, type ReflexBus } from "../bus";
import { buildNatsTransport } from "../bus/nats-transport";
import type { ReflexActor } from "../bus/envelopes";
import type { Command } from "../cmd/protocol";
import { loadConfig } from "../config/load";
import type { ReflexConfig } from "../config/schema";
import { serviceCommand } from "../service/run";
import { DEFAULT_REQUEST_TIMEOUT_MS, TransportUnreachable, requestCommand } from "./client";
import { EXIT_DOMAIN, EXIT_OK, EXIT_TRANSPORT, renderResponse, table, type Rendered } from "./render";

export interface CliIo {
  /** Injectable for tests; defaults talk to a real NATS bus from config. */
  makeBus?: (cfg: ReflexConfig) => ReflexBus;
  cfg?: ReflexConfig;
}

function operatorActor(): ReflexActor {
  return { type: "operator", id: userInfo().username };
}

function resolveRequestTimeout(raw: unknown = DEFAULT_REQUEST_TIMEOUT_MS): number {
  const timeout = Number(raw);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new InvalidArgumentError("expected a positive integer in milliseconds");
  }
  return timeout;
}

function requestTimeoutOption(): Option {
  return new Option("--timeout <ms>", "request timeout in milliseconds (flag overrides environment)")
    .default(resolveRequestTimeout())
    .env("REFLEX_REQUEST_TIMEOUT_MS")
    .argParser(resolveRequestTimeout);
}

/** Run one CLI invocation; returns the rendered result (bin prints + exits). */
export async function runCommand(argv: string[], io: CliIo = {}): Promise<Rendered> {
  let result: Rendered = { exitCode: EXIT_OK, stdout: "" };
  const program = new Commander("reflex").exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: (text) => { result.stdout += text; } });

  const remote = (command: Command, human: (data: unknown) => string, argsOf: (cmdArgs: Record<string, unknown>) => Record<string, unknown>) => {
    return async (...cliArgs: unknown[]) => {
      const opts = (cliArgs.at(-2) ?? {}) as Record<string, unknown>;
      const json = Boolean(opts.json);
      const timeout = resolveRequestTimeout(opts.timeout);
      const cfg = io.cfg ?? loadConfig();
      const bus = (io.makeBus ?? ((c: ReflexConfig) => createReflexBus(c, { transport: buildNatsTransport(c) })))(cfg);
      try {
        const response = await requestCommand(bus, cfg, command, argsOf(positionalArgs(cliArgs, opts)), operatorActor(), timeout);
        result = renderResponse(response, { json, human });
      } catch (error) {
        if (error instanceof TransportUnreachable) {
          result = { exitCode: EXIT_TRANSPORT, stdout: "", stderr: error.message };
        } else {
          result = { exitCode: EXIT_TRANSPORT, stdout: "", stderr: (error as Error).message };
        }
      } finally {
        await bus.close().catch(() => {});
      }
    };
  };

  const positionalArgs = (cliArgs: unknown[], opts: Record<string, unknown>): Record<string, unknown> => {
    const positionals = cliArgs.slice(0, -2) as string[];
    return { positionals, opts };
  };

  const routine = program.command("routine").description("Install and manage Reflex-owned scheduled routines");
  routine.command("add")
    .requiredOption("--id <id>")
    .requiredOption("--schedule <expression>")
    .requiredOption("--timezone <iana>")
    .requiredOption("--target <target>")
    .requiredOption("--payload <json>")
    .option("--policy <policy>", "approve or auto", "approve")
    .option("--serves-goal <goal>")
    .option("--flow-file <path>", "Install a supplied YAML flow into Reflex-owned storage")
    .option("--json")
    .addOption(requestTimeoutOption())
    .action(async (opts: Record<string, unknown>, cmd: unknown) => {
      let payload: unknown;
      try { payload = JSON.parse(String(opts.payload)); } catch {
        result = { exitCode: EXIT_DOMAIN, stdout: "", stderr: "--payload must be a JSON object" };
        return;
      }
      let flow: string | undefined;
      if (typeof opts.flowFile === "string") {
        try { flow = await Bun.file(opts.flowFile).text(); } catch {
          result = { exitCode: EXIT_DOMAIN, stdout: "", stderr: "Unable to read --flow-file" };
          return;
        }
      }
      await remote("routine-add", (data) => JSON.stringify(data), () => ({
        id: opts.id, schedule: opts.schedule, timezone: opts.timezone, target: opts.target,
        payload, policy: opts.policy, ...(flow === undefined ? {} : { flow }), ...(opts.servesGoal ? { servesGoal: opts.servesGoal } : {}),
      }))(opts, cmd);
    });
  routine.command("remove <id>").option("--json").addOption(requestTimeoutOption())
    .action(async (id: string, opts: Record<string, unknown>, cmd: unknown) => {
      await remote("routine-remove", (data) => JSON.stringify(data), () => ({ id }))(id, opts, cmd);
    });
  routine.command("set-policy <id> <policy>").option("--json").addOption(requestTimeoutOption())
    .action(async (id: string, policy: string, opts: Record<string, unknown>, cmd: unknown) => {
      await remote("routine-set-policy", (data) => JSON.stringify(data), () => ({ id, policy }))(id, policy, opts, cmd);
    });
  routine.command("list").option("--json").addOption(requestTimeoutOption())
    .action(remote("routine-list", (data) => table(data as Array<Record<string, unknown>>, ["id", "schedule", "policy", "target", "lastDecision"]), () => ({})));

  program
    .command("status")
    .description("Daemon health: blueprints, Matched Decisions awaiting approval, bus metrics.\nExample: reflex status --json")
    .option("--json", "raw JSON output")
    .addOption(requestTimeoutOption())
    .action(
      remote(
        "status",
        (data) => {
          const d = data as {
            version: string;
            instanceId: string;
            blueprints: { total: number; byKind: Record<string, number> };
            waitingApprovals: number;
            bus: Record<string, unknown>;
            nextTicks: Array<{ blueprintId: string; nextTick: string }>;
          };
          return [
            `reflex-daemon ${d.version} (instance ${d.instanceId.slice(0, 8)})`,
            `blueprints: ${d.blueprints.total} (${Object.entries(d.blueprints.byKind).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"})`,
            `Matched Decisions awaiting approval: ${d.waitingApprovals}`,
            `bus: published ${d.bus.published}, received ${d.bus.received}, queued ${d.bus.queued}, dropped ${d.bus.dropped}`,
            d.nextTicks.length ? `next ticks: ${d.nextTicks.map((t) => `${t.blueprintId} @ ${t.nextTick}`).join("; ")}` : "next ticks: none",
          ].join("\n");
        },
        () => ({}),
      ),
    );

  program
    .command("list")
    .description("Loaded Activation Blueprints.\nExample: reflex list --kind schedule")
    .option("--kind <kind>", "filter by impulse kind")
    .option("--target <target>", "filter by target")
    .option("--json", "raw JSON output")
    .addOption(requestTimeoutOption())
    .action(
      remote(
        "list",
        (data) => {
          let rows = data as Array<Record<string, unknown>>;
          return table(rows, ["id", "kind", "policy", "target"]);
        },
        ({ opts }) => ({ kind: (opts as Record<string, unknown>).kind, target: (opts as Record<string, unknown>).target }),
      ),
    );

  program
    .command("fire <blueprint-id>")
    .description("Produce a manual Impulse through the full pipeline (no guard bypass).\nExample: reflex fire f-testing --input '{\"suite\":\"smoke\"}'")
    .option("--input <json>", "Activation Payload merged into the impulse", "{}")
    .option("--json", "raw JSON output")
    .addOption(requestTimeoutOption())
    .action(async (blueprintId: string, opts: Record<string, unknown>, cmd: unknown) => {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(String(opts.input ?? "{}"));
      } catch {
        result = { exitCode: EXIT_DOMAIN, stdout: "", stderr: `error [invalid-input]: --input is not valid JSON` };
        return;
      }
      await remote(
        "fire",
        (data) => {
          const d = data as { outcome: string; decisionId?: string; reason?: string; correlationId?: string };
          return `${d.outcome}${d.decisionId ? ` (decision ${d.decisionId})` : ""}${d.reason ? ` — ${d.reason}` : ""}`;
        },
        () => ({ blueprintId, input }),
      )(blueprintId, opts, cmd);
    });

  for (const [name, command] of [
    ["approve", "approve"],
    ["deny", "deny"],
  ] as const) {
    program
      .command(`${name} <decision-id>`)
      .description(`${name === "approve" ? "Approve" : "Deny"} a Matched Decision awaiting approval.\nExample: reflex ${name} <decision-id>`)
      .option("--json", "raw JSON output")
      .addOption(requestTimeoutOption())
      .action(async (decisionId: string, opts: Record<string, unknown>, cmd: unknown) => {
        await remote(
          command as Command,
          (data) => {
            const d = data as { outcome: string; decisionId?: string; reason?: string };
            return `${d.outcome}${d.decisionId ? ` (decision ${d.decisionId})` : ""}${d.reason ? ` — ${d.reason}` : ""}`;
          },
          () => ({ decisionId }),
        )(decisionId, opts, cmd);
      });
  }

  program
    .command("pending")
    .description("Matched Decisions awaiting approval.\nExample: reflex pending")
    .option("--json", "raw JSON output")
    .addOption(requestTimeoutOption())
    .action(
      remote(
        "matched",
        (data) => {
          const rows = data as Array<Record<string, unknown>>;
          return `Matched Decisions awaiting approval:\n${table(rows, ["decisionId", "blueprintId", "matchedAt", "expiresAt", "impulseSummary"])}`;
        },
        () => ({}),
      ),
    );

  program
    .command("history")
    .description("Decision history, newest first.\nExample: reflex history --blueprint pr-stats-daily --limit 20")
    .option("--blueprint <id>", "filter by blueprint")
    .option("--limit <n>", "max rows (server caps at 200)", "50")
    .option("--json", "raw JSON output")
    .addOption(requestTimeoutOption())
    .action(
      remote(
        "history",
        (data) => table(data as Array<Record<string, unknown>>, ["at", "blueprintId", "outcome", "reason", "decisionId"]),
        ({ opts }) => ({
          blueprintId: (opts as Record<string, unknown>).blueprint,
          limit: Number((opts as Record<string, unknown>).limit ?? 50),
        }),
      ),
    );

  program
    .command("test <blueprint-id>")
    .description("Dry Run: predicted outcome, zero side effects.\nExample: reflex test pr-stats-daily")
    .option("--impulse <json>", "synthetic impulse payload", "{}")
    .option("--json", "raw JSON output")
    .addOption(requestTimeoutOption())
    .action(async (blueprintId: string, opts: Record<string, unknown>, cmd: unknown) => {
      // Local parse FIRST (same as --input): malformed JSON is a domain
      // error (exit 1), never a fake transport failure (sage R-107 finding).
      let impulse: Record<string, unknown>;
      try {
        impulse = JSON.parse(String(opts.impulse ?? "{}"));
      } catch {
        result = { exitCode: EXIT_DOMAIN, stdout: "", stderr: `error [invalid-input]: --impulse is not valid JSON` };
        return;
      }
      await remote(
        "dry-run",
        (data) => {
          const d = data as { wouldOutcome: string; reasons: string[] };
          return `DRY RUN — would ${d.wouldOutcome}: ${d.reasons.join("; ")}`;
        },
        () => ({ blueprintId, impulse }),
      )(blueprintId, opts, cmd);
    });

  program
    .command("validate [paths...]")
    .description("Validate activation documents locally — no daemon, no NATS.\nExample: reflex validate examples/")
    .option("--json", "raw JSON output")
    .action(async (paths: string[], opts: Record<string, unknown>) => {
      const targets = paths.length > 0 ? paths : ["."];
      const validation = await validatePaths(targets);
      if (Boolean(opts.json)) {
        result = { exitCode: validation.ok ? EXIT_OK : EXIT_DOMAIN, stdout: JSON.stringify(validation, null, 2) };
        return;
      }
      const lines = validation.ok
        ? [`ok — ${validation.blueprints.length} Activation Blueprint(s) valid`]
        : validation.errors.map((e) => `error: ${e.message}`);
      result = { exitCode: validation.ok ? EXIT_OK : EXIT_DOMAIN, stdout: lines.join("\n\n") };
    });

  program
    .command("service <verb>")
    .description(
      "Manage the daemon as a launchd LaunchAgent (macOS) or systemd user unit (Linux).\n" +
        "Example: reflex service install   (verbs: install|uninstall|start|stop|status|logs)\n" +
        "Named second service: reflex service install --instance personal --config ~/.config/reflex/personal.yaml",
    )
    .option("--follow", "follow logs (logs verb)")
    .option("--instance <name>", "act on the named service ai.meta-factory.reflex.<name> instead of the default")
    .option("--config <path>", "config file the named instance reads (install --instance only)")
    .action(async (verb: string, opts: Record<string, unknown>) => {
      result = await serviceCommand(verb, {
        follow: Boolean(opts.follow),
        ...(typeof opts.instance === "string" ? { instance: opts.instance } : {}),
        ...(typeof opts.config === "string" ? { config: opts.config } : {}),
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return result;
    // commander usage errors (unknown command/flag, missing arg)
    return { exitCode: EXIT_DOMAIN, stdout: "", stderr: (error as Error).message };
  }
  return result;
}
