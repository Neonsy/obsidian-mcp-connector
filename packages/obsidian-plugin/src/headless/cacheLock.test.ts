import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCacheLock,
  lockAddress,
  type Listen,
  type LockHandle,
} from "./cacheLock";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelock-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("lockAddress", () => {
  test("is stable per vault folder and differs between vaults", () => {
    const a = lockAddress("/c", "/c/a-1", "linux");
    expect(lockAddress("/c", "/c/a-1", "linux")).toBe(a);
    expect(lockAddress("/c", "/c/b-2", "linux")).not.toBe(a);
  });

  test("names an abstract socket on Linux, a pipe on Windows, a file elsewhere", () => {
    expect(lockAddress("/c", "/c/a-1", "linux")).toStartWith(
      "\0obsidian-mcp-connector-",
    );
    expect(lockAddress("C:\\c", "C:\\c\\a-1", "win32")).toStartWith(
      "\\\\.\\pipe\\obsidian-mcp-connector-",
    );
    const file = lockAddress("/c", "/c/a-1", "darwin");
    expect(path.dirname(file)).toBe("/c");
    expect(file).toEndWith(".sock");
  });
});

describe("createCacheLock on a real socket", () => {
  test("a second acquisition of the same name is refused until the first is released", async () => {
    const address = lockAddress(dir, dir);
    const first = createCacheLock(address);
    const second = createCacheLock(address);
    expect(await first.acquire()).toEqual({ ok: true });
    expect(await second.acquire()).toEqual({ ok: false });
    await first.release();
    expect(await second.acquire()).toEqual({ ok: true });
    await second.release();
    // Free again for anyone.
    const third = createCacheLock(address);
    expect(await third.acquire()).toEqual({ ok: true });
    await third.release();
  });

  test("a different vault's lock is independent", async () => {
    const a = createCacheLock(lockAddress(dir, path.join(dir, "a")));
    const b = createCacheLock(lockAddress(dir, path.join(dir, "b")));
    expect(await a.acquire()).toEqual({ ok: true });
    expect(await b.acquire()).toEqual({ ok: true });
    await a.release();
    await b.release();
  });
});

describe("createCacheLock on a socket file", () => {
  const sockets = (name: string) => path.join(dir, name);

  test("a live owner's file is left alone", async () => {
    const file = sockets("live.sock");
    const owner = createCacheLock(file);
    expect(await owner.acquire()).toEqual({ ok: true });
    const other = createCacheLock(file);
    expect(await other.acquire()).toEqual({ ok: false });
    expect(fs.existsSync(file)).toBe(true);
    // Still the owner's: the file is not removed by the refused attempt.
    expect(await createCacheLock(file).acquire()).toEqual({ ok: false });
    await owner.release();
  });

  test("a file left by a killed owner is removed and the lock is taken", async () => {
    const file = sockets("dead.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(process.argv[1], () => console.log("ready"));`,
        file,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    expect(fs.existsSync(file)).toBe(true);

    const lock = createCacheLock(file);
    expect(await lock.acquire()).toEqual({ ok: true });
    await lock.release();
  });
});

describe("createCacheLock with an injected listen", () => {
  function fakeNetwork() {
    const held = new Set<string>();
    let binds = 0;
    const closes: string[] = [];
    const listen: Listen = async (address) => {
      binds++;
      if (held.has(address)) return "in-use";
      held.add(address);
      const handle: LockHandle = {
        close: async () => {
          closes.push(address);
          held.delete(address);
        },
      };
      return handle;
    };
    return { listen, held, closes, binds: () => binds };
  }

  test("acquire is cheap once held and release frees the name", async () => {
    const net = fakeNetwork();
    const lock = createCacheLock("A", { listen: net.listen });
    expect(await lock.acquire()).toEqual({ ok: true });
    expect(await lock.acquire()).toEqual({ ok: true });
    expect(net.binds()).toBe(1);
    await lock.release();
    expect(net.closes).toEqual(["A"]);
    await lock.release();
    expect(net.closes).toEqual(["A"]);
  });

  test("a refusal is retried by the next acquire", async () => {
    const net = fakeNetwork();
    net.held.add("A");
    const lock = createCacheLock("A", { listen: net.listen });
    expect(await lock.acquire()).toEqual({ ok: false });
    net.held.delete("A");
    expect(await lock.acquire()).toEqual({ ok: true });
    await lock.release();
  });

  test("an unexpected bind error is reported, not thrown", async () => {
    const lock = createCacheLock("A", {
      listen: () => Promise.reject(new Error("EACCES: nope")),
    });
    expect(await lock.acquire()).toEqual({ ok: false, error: "EACCES: nope" });
  });

  test("concurrent acquires share one bind, and release waits for it", async () => {
    let binds = 0;
    let finish!: (handle: LockHandle) => void;
    const pending = new Promise<LockHandle>((resolve) => (finish = resolve));
    const lock = createCacheLock("A", {
      listen: () => {
        binds++;
        return pending;
      },
    });
    const first = lock.acquire();
    const second = lock.acquire();
    const released = lock.release();
    let closed = false;
    finish({
      close: async () => {
        closed = true;
      },
    });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    await released;
    expect(binds).toBe(1);
    expect(closed).toBe(true);
  });
});
