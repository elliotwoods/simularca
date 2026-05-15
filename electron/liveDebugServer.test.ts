import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { canWriteJsonResponse, isIgnorablePipeError, writeJsonSafe } from "./liveDebugServer";

function createResponseStub(overrides: Partial<ServerResponse> = {}): ServerResponse {
  const response = {
    destroyed: false,
    writableEnded: false,
    socket: { destroyed: false },
    statusCode: 200,
    setHeader: () => {},
    end: () => {}
  };
  return { ...response, ...overrides } as unknown as ServerResponse;
}

describe("liveDebugServer socket guards", () => {
  it("recognizes benign broken-pipe style errors", () => {
    expect(isIgnorablePipeError({ code: "EPIPE" })).toBe(true);
    expect(isIgnorablePipeError({ code: "ECONNRESET" })).toBe(true);
    expect(isIgnorablePipeError({ message: "socket hang up" })).toBe(true);
    expect(isIgnorablePipeError({ code: "EINVAL" })).toBe(false);
  });

  it("refuses to write to destroyed responses", () => {
    const response = createResponseStub({ destroyed: true });

    expect(canWriteJsonResponse(response)).toBe(false);
    expect(writeJsonSafe(response, { ok: true })).toBe(false);
  });

  it("swallows ignorable pipe errors from response writes", () => {
    const response = createResponseStub({
      end: () => {
        const error = new Error("broken pipe");
        (error as Error & { code: string }).code = "EPIPE";
        throw error;
      }
    });

    expect(writeJsonSafe(response, { ok: true })).toBe(false);
  });

  it("rethrows non-ignorable response write failures", () => {
    const response = createResponseStub({
      end: () => {
        throw new Error("unexpected failure");
      }
    });

    expect(() => writeJsonSafe(response, { ok: true })).toThrow("unexpected failure");
  });
});
