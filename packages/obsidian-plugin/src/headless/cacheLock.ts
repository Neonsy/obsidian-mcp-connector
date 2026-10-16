/**
 * One writer per vault index. Two servers for the same vault (say, two MCP
 * clients that each spawn one) would otherwise interleave writes to the
 * same cache folder and corrupt the index.
 *
 * The lock is a listening local socket that the operating system holds for
 * the process. Binding the name succeeds for one process only and fails
 * with EADDRINUSE for the rest. When the holder dies, however it dies, the
 * kernel frees the name, so there is no stale lock to detect or reclaim.
 * The server handle is unref'd: the lock never keeps the process alive.
 *
 * Linux uses an abstract socket and Windows a named pipe, both released by
 * the kernel. Other systems (macOS) bind a socket file, which a killed
 * holder leaves behind. There a failed bind probes the file once: a
 * refused connection means no owner is left, so the file is removed and
 * the bind is tried again.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** A held lock. */
export type LockHandle = { close(): Promise<void> };

/** Bind `address`: a handle when this process now holds it, else "in-use". */
export type Listen = (address: string) => Promise<LockHandle | "in-use">;

export type CacheLockDeps = { listen?: Listen };

export type AcquireResult =
  /** This process holds the lock. */
  | { ok: true }
  /** Another process holds it, or `error` says why it could not be taken. */
  | { ok: false; error?: string };

export type CacheLock = {
  /** Take the lock, or report that another process holds it. Never rejects. */
  acquire(): Promise<AcquireResult>;
  /** Give the lock up, once any acquisition in flight has settled. */
  release(): Promise<void>;
};

/**
 * Where the lock for one vault lives. `vaultDir` is the vault's cache
 * folder, so the name is as unique per vault as the folder is. The socket
 * file for other systems sits in the shared cache root: a socket path is
 * limited to about a hundred bytes, which a long vault name would exceed.
 */
export function lockAddress(
  root: string,
  vaultDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const id = createHash("sha256").update(vaultDir).digest("hex").slice(0, 16);
  const name = `obsidian-mcp-connector-${id}`;
  if (platform === "linux") return `\0${name}`;
  if (platform === "win32") return `\\\\.\\pipe\\${name}`;
  return path.join(root, `lock-${id}.sock`);
}

const isSocketFile = (address: string): boolean =>
  !address.startsWith("\0") && !address.startsWith("\\\\");

const hasCode = (err: unknown, code: string): boolean =>
  (err as NodeJS.ErrnoException).code === code;

const listenOnSocket: Listen = (address) =>
  new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.unref();
    const onError = (err: Error) =>
      hasCode(err, "EADDRINUSE") ? resolve("in-use") : reject(err);
    server.once("error", onError);
    server.listen(address, () => {
      server.removeListener("error", onError);
      // A late error on a bound socket must not crash the process.
      server.on("error", () => {});
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });

/** True when nothing answers on the socket file: its owner is gone. */
const socketFileIsDead = (address: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(address);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (err) =>
      resolve(hasCode(err, "ECONNREFUSED") || hasCode(err, "ENOENT")),
    );
  });

async function bind(listen: Listen, address: string) {
  const first = await listen(address);
  if (first !== "in-use" || !isSocketFile(address)) return first;
  if (!(await socketFileIsDead(address))) return first;
  try {
    fs.unlinkSync(address);
  } catch (err) {
    if (!hasCode(err, "ENOENT")) throw err;
  }
  return listen(address);
}

export function createCacheLock(
  address: string,
  deps: CacheLockDeps = {},
): CacheLock {
  const listen = deps.listen ?? listenOnSocket;
  let handle: LockHandle | undefined;
  let inFlight: Promise<AcquireResult> | undefined;

  function acquire(): Promise<AcquireResult> {
    if (handle) return Promise.resolve({ ok: true });
    // Searches arriving while a bind is pending share it.
    inFlight ??= bind(listen, address)
      .then(
        (got): AcquireResult => {
          if (got === "in-use") return { ok: false };
          handle = got;
          return { ok: true };
        },
        (err: unknown): AcquireResult => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  async function release(): Promise<void> {
    await inFlight;
    const held = handle;
    handle = undefined;
    await held?.close();
  }

  return { acquire, release };
}
