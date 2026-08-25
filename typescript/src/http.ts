import {
  AgentStackApiError,
  AgentStackError,
  ConflictError,
  ConnectionError,
  OutcomeUnknownError,
} from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

type RetryMode = "never" | "safe";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
  requestId?: string;
  retry?: RetryMode;
  signal?: AbortSignal;
  outcomeUnknown?: boolean;
}

export interface HttpResult<T> {
  data: T;
  etag: string | undefined;
  requestId: string;
}

export interface HttpStream {
  response: Response;
  requestId: string;
}

export const requireEtag = <T>(result: HttpResult<T>): string => {
  if (!result.etag) {
    throw new AgentStackError("Agent Service response omitted a required ETag", {
      requestId: result.requestId,
    });
  }
  return result.etag;
};

const requestId = (): string => crypto.randomUUID();
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const errorInput = async (
  response: Response,
  fallbackRequestId: string,
): Promise<ConstructorParameters<typeof AgentStackApiError>[0]> => {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  const envelope = value as {
    error?: { code?: unknown; message?: unknown; details?: unknown };
  };
  const error = envelope?.error;
  return {
    status: response.status,
    code: typeof error?.code === "string" ? error.code : "http_error",
    message:
      typeof error?.message === "string"
        ? error.message
        : `Agent Service request failed with status ${response.status}`,
    requestId: response.headers.get("x-request-id") ?? fallbackRequestId,
    ...(error && "details" in error ? { details: error.details } : {}),
  };
};

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("baseUrl must be an HTTP(S) URL without credentials");
  }
  return url.toString().replace(/\/$/, "");
};

export class HttpClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #projectId: string | undefined;

  constructor(input: { baseUrl: string; apiKey: string; projectId?: string }) {
    this.#baseUrl = normalizeBaseUrl(input.baseUrl);
    this.#apiKey = input.apiKey;
    this.#projectId = input.projectId;
  }

  #headers(options: RequestOptions, stableRequestId: string): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      "x-request-id": stableRequestId,
      ...(this.#projectId ? { "x-agent9-project-id": this.#projectId } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    };
  }

  get<T>(path: string, options?: Pick<RequestOptions, "signal">): Promise<T> {
    return this.request(path, { ...options, retry: "safe" });
  }

  getResponse<T>(path: string, options?: Pick<RequestOptions, "signal">): Promise<HttpResult<T>> {
    return this.response(path, { ...options, retry: "safe" });
  }

  post<T>(
    path: string,
    body: unknown,
    options?: Pick<RequestOptions, "outcomeUnknown" | "requestId" | "signal"> & {
      idempotent?: boolean;
    },
  ): Promise<T> {
    return this.request(path, {
      ...options,
      method: "POST",
      body,
      retry: options?.idempotent ? "safe" : "never",
    });
  }

  postResponse<T>(
    path: string,
    body: unknown,
    options?: Pick<
      RequestOptions,
      "idempotencyKey" | "ifMatch" | "outcomeUnknown" | "requestId" | "signal"
    > & { idempotent?: boolean },
  ): Promise<HttpResult<T>> {
    return this.response(path, {
      ...options,
      method: "POST",
      body,
      retry: options?.idempotent ? "safe" : "never",
    });
  }

  patchResponse<T>(
    path: string,
    body: unknown,
    options: Pick<RequestOptions, "ifMatch" | "outcomeUnknown" | "signal">,
  ): Promise<HttpResult<T>> {
    return this.response(path, { ...options, method: "PATCH", body });
  }

  put<T>(
    path: string,
    body: unknown,
    options?: Pick<RequestOptions, "outcomeUnknown" | "signal">,
  ): Promise<T> {
    return this.request(path, { ...options, method: "PUT", body });
  }

  async openStream(
    path: string,
    body: unknown,
    options?: Pick<RequestOptions, "requestId" | "signal">,
  ): Promise<HttpStream> {
    const stableRequestId = options?.requestId ?? requestId();
    if (!REQUEST_ID.test(stableRequestId)) {
      throw new TypeError("requestId must be 1-64 safe characters");
    }
    const requestOptions: RequestOptions = {
      method: "POST",
      body,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...this.#headers(requestOptions, stableRequestId),
          accept: "application/x-ndjson",
        },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      if (options?.signal?.aborted) throw options.signal.reason ?? cause;
      throw new OutcomeUnknownError(
        "Turn request outcome is unknown; the request was not replayed",
        { requestId: stableRequestId, cause },
      );
    }
    if (!response.ok) {
      const input = await errorInput(response, stableRequestId);
      throw input.status === 409 || input.status === 412
        ? new ConflictError(input)
        : new AgentStackApiError(input);
    }
    if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      throw new OutcomeUnknownError("Agent Service returned an invalid Turn stream", {
        requestId: response.headers.get("x-request-id") ?? stableRequestId,
      });
    }
    return {
      response,
      requestId: response.headers.get("x-request-id") ?? stableRequestId,
    };
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.response<T>(path, options)).data;
  }

  async response<T>(path: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    const stableRequestId = options.requestId ?? requestId();
    if (!REQUEST_ID.test(stableRequestId)) {
      throw new TypeError("requestId must be 1-64 safe characters");
    }
    if (
      options.idempotencyKey !== undefined &&
      (options.idempotencyKey.length > 255 || !/^[\x20-\x7e]+$/.test(options.idempotencyKey))
    ) {
      throw new TypeError("idempotencyKey must be 1-255 visible ASCII characters");
    }
    const attempts = options.retry === "safe" ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.#baseUrl}${path}`, {
          method: options.method ?? "GET",
          headers: this.#headers(options, stableRequestId),
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (attempt < attempts) {
          await sleep(100 * 2 ** (attempt - 1), options.signal);
          continue;
        }
        const ErrorClass = options.outcomeUnknown ? OutcomeUnknownError : ConnectionError;
        throw new ErrorClass(
          options.outcomeUnknown
            ? "Agent Service request outcome is unknown; do not repeat it automatically"
            : "Could not reach Agent Service",
          {
            requestId: stableRequestId,
            cause,
          },
        );
      }

      if (response.ok) {
        let data: T;
        if (response.status === 204) {
          data = undefined as T;
        } else {
          try {
            data = (await response.json()) as T;
          } catch (cause) {
            const ErrorClass = options.outcomeUnknown ? OutcomeUnknownError : AgentStackError;
            throw new ErrorClass(
              options.outcomeUnknown
                ? "Agent Service accepted the request but returned an unusable response"
                : "Agent Service returned invalid JSON",
              {
                requestId: response.headers.get("x-request-id") ?? stableRequestId,
                cause,
              },
            );
          }
        }
        return {
          data,
          etag: response.headers.get("etag") ?? undefined,
          requestId: response.headers.get("x-request-id") ?? stableRequestId,
        };
      }

      if (attempt < attempts && RETRYABLE_STATUS.has(response.status)) {
        await response.arrayBuffer();
        await sleep(100 * 2 ** (attempt - 1), options.signal);
        continue;
      }

      const input = await errorInput(response, stableRequestId);
      throw input.status === 409 || input.status === 412
        ? new ConflictError(input)
        : new AgentStackApiError(input);
    }
    throw new Error("unreachable");
  }
}
