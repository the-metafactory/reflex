import { describe, expect, it, mock } from "bun:test";
import { TimeoutError, PermissionViolationError, AuthorizationError, NoRespondersError } from "@nats-io/nats-core";
import { JetStreamApiError } from "@nats-io/jetstream";
import type { StreamInfo, StreamConfig } from "@nats-io/jetstream";
import { ensureReflexStream, reflexStreamSubjects, REFLEX_STREAM_NAME } from "../src/bus/stream";
import { testConfig } from "./helpers";

describe("reflex stream config", () => {
  it("derives the wildcard from principal + stack, never hand-built elsewhere", () => {
    const cfg = testConfig();
    expect(reflexStreamSubjects(cfg)).toEqual(["local.jc.default.reflex.>"]);
  });

  it("stream name is REFLEX", () => {
    expect(REFLEX_STREAM_NAME).toBe("REFLEX");
  });
});

const existing = { config: { name: "REFLEX", subjects: ["local.other.stack.reflex.>"] } } as StreamInfo;
const missing = () => new JetStreamApiError({ code: 404, err_code: 10059, description: "stream not found" });

describe("ensureReflexStream", () => {
  it("retries timeouts with capped backoff, without creating an existing stream", async () => {
    let calls = 0;
    const info = mock(async () => {
      if (++calls < 10) throw new TimeoutError();
      return existing;
    });
    const add = mock(async () => existing);
    const sleep = mock(async (_ms: number) => {});
    await ensureReflexStream({ getStreamManager: async () => ({ streams: { info, add } }) }, testConfig(), { sleep });
    expect(info).toHaveBeenCalledTimes(10);
    expect(add).not.toHaveBeenCalled();
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect(existing.config.subjects).toEqual(["local.other.stack.reflex.>"]);
  });

  it("creates only after definite not-found, preserving the stream configuration", async () => {
    let calls = 0;
    const info = mock(async () => {
      if (++calls === 1) throw new TimeoutError();
      throw missing();
    });
    const add = mock(async (_config: Partial<StreamConfig>) => existing);
    await ensureReflexStream({ getStreamManager: async () => ({ streams: { info, add } }) }, testConfig(), { sleep: async () => {} });
    expect(info).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]).toEqual([{
      name: "REFLEX", subjects: ["local.jc.default.reflex.>"],
      retention: "limits", storage: "file", discard: "old",
      max_bytes: 512 * 1024 * 1024, max_age: 7 * 24 * 60 * 60 * 1e9, num_replicas: 1,
    }]);
  });

  it("rechecks existence after a create timeout (the server may have created it)", async () => {
    let calls = 0;
    const info = mock(async () => {
      if (++calls === 1) throw missing();
      return existing;
    });
    const add = mock(async (): Promise<StreamInfo> => { throw new TimeoutError(); });
    await ensureReflexStream({ getStreamManager: async () => ({ streams: { info, add } }) }, testConfig(), { sleep: async () => {} });
    expect(info).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("retries a timed-out manager initialization", async () => {
    let calls = 0;
    const info = mock(async () => existing);
    const add = mock(async () => existing);
    const getStreamManager = mock(async () => {
      if (++calls < 3) throw new TimeoutError();
      return { streams: { info, add } };
    });
    await ensureReflexStream({ getStreamManager }, testConfig(), { sleep: async () => {} });
    expect(getStreamManager).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects clearly after ten timeout attempts, retaining the cause", async () => {
    const timeout = new TimeoutError();
    const info = mock(async (): Promise<StreamInfo> => { throw timeout; });
    const add = mock(async () => existing);
    const sleep = mock(async (_ms: number) => {});
    const error = await ensureReflexStream({ getStreamManager: async () => ({ streams: { info, add } }) }, testConfig(), { sleep }).catch((e) => e);
    expect(error.message).toContain("REFLEX after 10 attempts (timeout retries exhausted)");
    expect(error.cause).toBe(timeout);
    expect(info).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledTimes(9);
    expect(add).not.toHaveBeenCalled();
  });

  it("fails immediately on permissions, authentication, unavailable JetStream, and other lookup errors", async () => {
    for (const error of [
      new PermissionViolationError("permission denied", "publish", "$JS.API.STREAM.INFO.REFLEX"), new AuthorizationError("authentication timeout"),
      new NoRespondersError("no responders"), new Error("timeout"),
      new JetStreamApiError({ code: 404, err_code: 10039, description: "JetStream not enabled" }),
    ]) {
      const info = mock(async (): Promise<StreamInfo> => { throw error; });
      const add = mock(async () => existing);
      const sleep = mock(async (_ms: number) => {});
      await expect(ensureReflexStream({ getStreamManager: async () => ({ streams: { info, add } }) }, testConfig(), { sleep })).rejects.toThrow();
      expect(info).toHaveBeenCalledTimes(1);
      expect(add).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("fails immediately on a conflicting stream creation", async () => {
    const conflict = new JetStreamApiError({ code: 400, err_code: 10058, description: "stream name already in use with a different configuration" });
    const info = mock(async (): Promise<StreamInfo> => { throw missing(); });
    const add = mock(async (): Promise<StreamInfo> => { throw conflict; });
    const sleep = mock(async (_ms: number) => {});
    await expect(ensureReflexStream({ getStreamManager: async () => ({ streams: { info, add } }) }, testConfig(), { sleep })).rejects.toThrow(/different configuration/);
    expect(info).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("skips memory transports, but refuses unsafe legacy provisioning", async () => {
    for (const transport of [null, undefined, 1, {}]) await ensureReflexStream(transport, testConfig());
    const ensureStream = mock(async () => {});
    await expect(ensureReflexStream({ ensureStream }, testConfig())).rejects.toThrow(/getStreamManager/);
    expect(ensureStream).not.toHaveBeenCalled();
  });
});
