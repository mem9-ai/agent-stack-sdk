import {
  AgentStackApiError,
  AgentStackError,
  ConflictError,
  ConnectionError,
} from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

type RetryMode = "never" | "safe";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  requestId?: string;
  retry?: RetryMode;
  signal?: AbortSignal;
}

const requestId = (): string => crypto.randomUUID();

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

  get<T>(path: string, options?: Pick<RequestOptions, "signal">): Promise<T> {
    return this.request(path, { ...options, retry: "safe" });
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const stableRequestId = options.requestId ?? requestId();
    const attempts = options.retry === "safe" ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.#baseUrl}${path}`, {
          method: options.method ?? "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#apiKey}`,
            "x-request-id": stableRequestId,
            ...(this.#projectId ? { "x-agent9-project-id": this.#projectId } : {}),
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (attempt < attempts) {
          await sleep(100 * 2 ** (attempt - 1), options.signal);
          continue;
        }
        throw new ConnectionError("Could not reach Agent Service", {
          requestId: stableRequestId,
          cause,
        });
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        try {
          return (await response.json()) as T;
        } catch (cause) {
          throw new AgentStackError("Agent Service returned invalid JSON", {
            requestId: response.headers.get("x-request-id") ?? stableRequestId,
            cause,
          });
        }
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
