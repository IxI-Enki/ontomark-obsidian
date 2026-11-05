// The endpoint rule shared by assisted ingest and the Jev option: https always,
// plain http only to this machine unless the user opted in.
import { describe, expect, it } from "vitest";
import { endpointProblem, isLoopbackHost } from "../src/endpoint";

const ok = (url: string, allowInsecureHttp = false): boolean => endpointProblem(url, { allowInsecureHttp }) === null;

describe("endpointProblem", () => {
  it("accepts https to any host", () => {
    for (const url of ["https://api.example.com/v1/chat/completions", "https://192.168.2.132:8084/v1", "https://localhost/v1"]) {
      expect(ok(url), url).toBe(true);
    }
  });

  it("accepts plain http to this machine in every spelling the URL parser normalises", () => {
    for (const url of [
      "http://localhost:8080/v1",
      "http://LOCALHOST/v1",
      "http://model.localhost/v1",
      "http://127.0.0.1:1/v1",
      "http://127.8.9.10/v1",
      "http://127.1/v1", // normalised to 127.0.0.1
      "http://2130706433/v1", // likewise
      "http://[::1]:9000/v1",
    ]) {
      expect(ok(url), url).toBe(true);
    }
  });

  it("refuses plain http to any other host by default, naming the way out", () => {
    for (const url of [
      "http://192.168.2.132:8084/v1",
      "http://10.0.0.5/v1",
      "http://api.example.com/v1",
      "http://localhost.example.com/v1",
      "http://128.0.0.1/v1",
      "http://[::2]/v1",
      "http://[::ffff:127.0.0.1]/v1",
    ]) {
      const problem = endpointProblem(url);
      expect(problem, url).toMatch(/plain http/);
      expect(problem, url).toContain("Allow plain http to other hosts");
    }
  });

  it("accepts plain http to another host only with the explicit opt-in", () => {
    expect(ok("http://192.168.2.132:8084/v1", true)).toBe(true);
    expect(ok("http://api.example.com/v1", true)).toBe(true);
  });

  it("the opt-in relaxes nothing else", () => {
    for (const url of ["ftp://192.168.2.132/v1", "http://u:p@192.168.2.132/v1", "http://192.168.2.132/v1#x", "not a url"]) {
      expect(ok(url, true), url).toBe(false);
    }
  });

  it("isLoopbackHost takes the parser's hostname", () => {
    expect(isLoopbackHost(new URL("http://[::1]/").hostname)).toBe(true);
    expect(isLoopbackHost(new URL("http://127.0.0.1/").hostname)).toBe(true);
    expect(isLoopbackHost("192.168.0.1")).toBe(false);
  });
});
