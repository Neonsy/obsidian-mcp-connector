import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as mocked from "obsidian";
import { requestUrl } from "./requestUrl";
import * as shim from "./obsidianShim";

type Seen = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

let server: http.Server;
let base: string;
let seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      switch (req.url) {
        case "/json":
          res.writeHead(200, {
            "Content-Type": "application/json",
            "X-Custom-Header": "Value",
          });
          res.end('{"a":[1,2]}');
          break;
        case "/html":
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h1>Title</h1><p>Hello <b>wörld</b></p><ul><li>one</li><li>two</li></ul></body></html>",
          );
          break;
        case "/missing":
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("no such page");
          break;
        case "/broken":
          res.writeHead(503);
          res.end("down");
          break;
        case "/redirect":
          res.writeHead(302, { Location: "/html" });
          res.end();
          break;
        case "/drop":
          req.socket.destroy();
          break;
        default:
          res.writeHead(200);
          res.end(`${req.method} ${req.url}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen = [];
});

describe("requestUrl", () => {
  test("a string is a GET and the response has status, lower-cased headers and bodies", async () => {
    const res = await requestUrl(`${base}/json`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["x-custom-header"]).toBe("Value");
    expect(res.text).toBe('{"a":[1,2]}');
    expect(res.json).toEqual({ a: [1, 2] });
    expect(new TextDecoder().decode(res.arrayBuffer)).toBe('{"a":[1,2]}');
    expect(seen[0].method).toBe("GET");
  });

  test("a body is decoded as UTF-8", async () => {
    const res = await requestUrl({ url: `${base}/html` });
    expect(res.text).toContain("wörld");
  });

  test("method, headers, content type and body are sent", async () => {
    const res = await requestUrl({
      url: `${base}/echo`,
      method: "POST",
      contentType: "application/x-test",
      headers: { "X-Probe": "1" },
      body: "payload",
    });
    expect(res.text).toBe("POST /echo");
    expect(seen[0]).toMatchObject({ method: "POST", body: "payload" });
    expect(seen[0].headers["content-type"]).toBe("application/x-test");
    expect(seen[0].headers["x-probe"]).toBe("1");
  });

  test("a status of 400 or more throws with the status", async () => {
    const err = (await requestUrl(`${base}/missing`).catch(
      (e: unknown) => e,
    )) as Error & { status?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Request failed, status 404");
    expect(err.status).toBe(404);
    await expect(requestUrl(`${base}/broken`)).rejects.toThrow(
      "Request failed, status 503",
    );
  });

  test("throw: false returns the response instead", async () => {
    const res = await requestUrl({ url: `${base}/missing`, throw: false });
    expect(res.status).toBe(404);
    expect(res.text).toBe("no such page");
  });

  test("a redirect is followed", async () => {
    const res = await requestUrl(`${base}/redirect`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<h1>Title</h1>");
  });

  test("a dropped connection throws an error with a message", async () => {
    const err = (await requestUrl(`${base}/drop`).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.length).toBeGreaterThan(0);
  });

  test("an unusable URL throws", async () => {
    await expect(requestUrl("not a url")).rejects.toThrow();
  });
});

describe("the fetch tool", () => {
  const original = { ...mocked };
  const realFetch = globalThis.fetch;
  let tool: typeof import("$/features/mcp-tools/tools/fetch");

  beforeAll(async () => {
    void mock.module("obsidian", () => ({
      ...original,
      requestUrl: shim.requestUrl,
    }));
    tool = await import("$/features/mcp-tools/tools/fetch");
  });
  afterAll(() => {
    void mock.module("obsidian", () => original);
  });
  beforeEach(() => {
    // The tool refuses loopback hosts, so a public-looking name is sent to
    // the local server instead. Nothing leaves the machine.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      return realFetch(`${base}${url.pathname}${url.search}`, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  type Result = { content: Array<{ text: string }>; isError?: boolean };
  const text = (r: Result) => r.content[0].text;

  test("converts HTML to Markdown with Turndown", async () => {
    const out = await tool.fetchHandler({
      arguments: { url: "http://pages.example/html" },
    });
    expect(out.isError).toBeUndefined();
    expect(text(out)).toBe("# Title\n\nHello **wörld**\n\n-   one\n-   two");
  });

  test("returns raw HTML and paginates", async () => {
    const out = await tool.fetchHandler({
      arguments: {
        url: "http://pages.example/html",
        format: "html",
        maxLength: 10,
        startIndex: 6,
      },
    });
    expect(text(out)).toStartWith("<body><h1>");
    expect(text(out)).toContain(
      "characters remaining; resume with startIndex=16",
    );
  });

  test("an error status is a fetch_failed result", async () => {
    const out = await tool.fetchHandler({
      arguments: { url: "http://pages.example/missing" },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(text(out))).toMatchObject({
      errorCode: "fetch_failed",
      error: "Fetch failed: Request failed, status 404",
    });
  });

  test("a loopback address is still refused by the tool before any request", async () => {
    const out = await tool.fetchHandler({
      arguments: { url: `${base}/html` },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(text(out)).errorCode).toBe("url_rejected");
    expect(seen).toHaveLength(0);
  });
});
