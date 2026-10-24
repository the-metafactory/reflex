import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createTransport } from "@the-metafactory/myelin";
import { createReflexBus, type ReflexBus } from "../../src/bus";
import { requestCommand, TransportUnreachable } from "../../src/cli/client";
import { runCommand } from "../../src/cli/main";
import { EXIT_DOMAIN, EXIT_OK, EXIT_TRANSPORT } from "../../src/cli/render";
import { CMD_REPLY_TYPE } from "../../src/cmd/protocol";
import { makeEnvelope, testConfig } from "../helpers";

const cfg = testConfig();
const actor = { type: "operator", id: "test" } as const;
const reply = makeEnvelope(cfg, {
  source: "reflex",
  type: CMD_REPLY_TYPE,
  payload: { v: 1, ok: true, data: { outcome: "fired" } },
});

/** Fake request transport with real reply/deadline timers, no daemon or NATS. */
function delayedBus(delayMs = 0) {
  const transport = createTransport({ type: "memory" });
  const request = mock<typeof transport.request>(async (_subject, _envelope, options) => {
    return new Promise((resolve, reject) => {
      const responseTimer = setTimeout(() => {
        clearTimeout(timeoutTimer);
        resolve(reply);
      }, delayMs);
      const timeoutTimer = setTimeout(() => {
        clearTimeout(responseTimer);
        reject(new Error(`Request timed out after ${options?.timeoutMs}ms`));
      }, options?.timeoutMs);
    });
  });
  transport.request = request;
  return { bus: createReflexBus(cfg, { transport }), request };
}

const remoteCommands = [
  ["status"], ["list"], ["fire", "demo"], ["approve", "decision"],
  ["deny", "decision"], ["pending"], ["history"], ["test", "demo"],
];
let savedTimeout: string | undefined;
beforeEach(() => {
  savedTimeout = process.env.REFLEX_REQUEST_TIMEOUT_MS;
  delete process.env.REFLEX_REQUEST_TIMEOUT_MS;
});
afterEach(() => {
  if (savedTimeout === undefined) delete process.env.REFLEX_REQUEST_TIMEOUT_MS;
  else process.env.REFLEX_REQUEST_TIMEOUT_MS = savedTimeout;
});

describe("CLI request timeouts", () => {
  for (const argv of remoteCommands) {
    it(`${argv[0]} uses 15 s by default, environment next, explicit flag first`, async () => {
      for (const [env, flag, expected] of [
        [undefined, undefined, 15_000],
        ["20000", undefined, 20_000],
        ["20000", "3000", 3_000],
      ] as const) {
        if (env === undefined) delete process.env.REFLEX_REQUEST_TIMEOUT_MS;
        else process.env.REFLEX_REQUEST_TIMEOUT_MS = env;
        const { bus, request } = delayedBus();
        const result = await runCommand([...argv, "--json", ...(flag ? ["--timeout", flag] : [])], {
          cfg, makeBus: () => bus,
        });
        expect(result.exitCode).toBe(EXIT_OK);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]![2]?.timeoutMs).toBe(expected);
      }
    });
  }

  it("client and CLI accept a reply later than the old 3 s default", async () => {
    const direct = delayedBus(3_100);
    const cli = delayedBus(3_100);
    try {
      const [response, result] = await Promise.all([
        requestCommand(direct.bus, cfg, "fire", { blueprintId: "demo" }, actor),
        runCommand(["fire", "demo"], { cfg, makeBus: () => cli.bus }),
      ]);
      expect(response.ok).toBe(true);
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.stdout).toBe("fired");
      expect(direct.request.mock.calls[0]![2]?.timeoutMs).toBe(15_000);
    } finally {
      await direct.bus.close();
      await cli.bus.close();
    }
  }, 10_000);

  it("times out beyond the new 15 s default with an uncertain-outcome warning", async () => {
    const { bus, request } = delayedBus(15_100);
    const result = await runCommand(["fire", "demo"], { cfg, makeBus: () => bus });
    expect(result.exitCode).toBe(EXIT_TRANSPORT);
    expect(result.stderr).toContain("15000ms");
    expect(result.stderr).toContain("request was sent");
    expect(result.stderr).toContain("daemon may still act");
    expect(result.stderr).toContain("reflex history");
    expect(result.stderr).toContain("reflex service logs");
    expect(result.stderr).not.toContain("daemon not reachable");
    expect(request).toHaveBeenCalledTimes(1);
  }, 25_000);

  it("honors shorter explicit and environment deadlines", async () => {
    for (const args of [[], ["--timeout", "40"]]) {
      process.env.REFLEX_REQUEST_TIMEOUT_MS = args.length ? "20000" : "40";
      const { bus } = delayedBus(100);
      const result = await runCommand(["fire", "demo", ...args], { cfg, makeBus: () => bus });
      expect(result.exitCode).toBe(EXIT_TRANSPORT);
      expect(result.stderr).toContain("40ms");
    }
  });

  it("keeps connection errors distinct from requests awaiting a reply", async () => {
    const { bus } = delayedBus();
    bus.request = async () => { throw new Error("connection refused"); };
    try {
      await expect(requestCommand(bus, cfg, "status", {}, actor)).rejects.toBeInstanceOf(TransportUnreachable);
      const result = await runCommand(["status"], { cfg, makeBus: () => bus });
      expect(result.exitCode).toBe(EXIT_TRANSPORT);
      expect(result.stderr).toContain("check NATS");
      expect(result.stderr).not.toContain("request was sent");
    } finally {
      await bus.close();
    }
  });

  it("also explains raw NATS timeout errors as uncertain outcomes", async () => {
    for (const message of ["timeout", "TIMEOUT"]) {
      const { bus } = delayedBus();
      bus.request = async () => { throw new Error(message); };
      const result = await runCommand(["fire", "demo"], { cfg, makeBus: () => bus });
      expect(result.exitCode).toBe(EXIT_TRANSPORT);
      expect(result.stderr).toContain("daemon may still act");
    }
  });

  it("shows the default, units and environment override in command help", async () => {
    for (const argv of remoteCommands) {
      const result = await runCommand([argv[0]!, "--help"]);
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.stdout).toContain("--timeout <ms>");
      expect(result.stdout).toContain("milliseconds");
      expect(result.stdout).toContain("15000");
      expect(result.stdout).toContain("REFLEX_REQUEST_TIMEOUT_MS");
    }
  });

  it("rejects invalid timeout configuration before creating a bus", async () => {
    const makeBus = mock<() => ReflexBus>(() => { throw new Error("must not connect"); });
    for (const value of ["nope", "0", "-1", "Infinity", "1.5"]) {
      const result = await runCommand(["status", "--timeout", value], { cfg, makeBus });
      expect(result.exitCode).toBe(EXIT_DOMAIN);
      expect(result.stderr).toContain("positive integer");
      process.env.REFLEX_REQUEST_TIMEOUT_MS = value;
      const fromEnv = await runCommand(["status"], { cfg, makeBus });
      expect(fromEnv.exitCode).toBe(EXIT_DOMAIN);
      expect(fromEnv.stderr).toContain("REFLEX_REQUEST_TIMEOUT_MS");
      delete process.env.REFLEX_REQUEST_TIMEOUT_MS;
    }
    expect(makeBus).not.toHaveBeenCalled();
  });
});
