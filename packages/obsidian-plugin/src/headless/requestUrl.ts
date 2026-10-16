/**
 * Obsidian's `requestUrl` over Node's global `fetch`, for the `fetch` tool.
 *
 * It keeps the parts of the contract the tool depends on: the response has
 * `status`, lower-cased `headers`, `arrayBuffer`, and `text` and `json`
 * decoded from the body, and a status of 400 or more throws an error
 * carrying `status` unless the request says `throw: false`. Redirects are
 * followed. It is not a general HTTP client: there is no timeout here (the
 * tool races its own) and the body is read whole.
 */

export type RequestUrlParam = {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  /** Throw on a status of 400 or more. Default true. */
  throw?: boolean;
};

export type RequestUrlResponse = {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  readonly text: string;
  readonly json: unknown;
};

function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  return cause instanceof Error && cause.message
    ? `${err.message}: ${cause.message}`
    : err.message;
}

export async function requestUrl(
  request: RequestUrlParam | string,
): Promise<RequestUrlResponse> {
  const params = typeof request === "string" ? { url: request } : request;
  const headers = { ...params.headers };
  if (params.contentType) headers["Content-Type"] = params.contentType;

  let res: Response;
  try {
    res = await fetch(params.url, {
      method: params.method ?? "GET",
      headers,
      body: params.body,
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(describeFailure(err));
  }

  const buffer = await res.arrayBuffer();
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  const response: RequestUrlResponse = {
    status: res.status,
    headers: responseHeaders,
    arrayBuffer: buffer,
    get text() {
      return new TextDecoder().decode(buffer);
    },
    get json() {
      return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
    },
  };
  if (res.status >= 400 && params.throw !== false) {
    throw Object.assign(new Error(`Request failed, status ${res.status}`), {
      status: res.status,
      headers: responseHeaders,
    });
  }
  return response;
}
