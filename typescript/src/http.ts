import {
  TiDBLinkApiError,
  TiDBLinkError,
  ConflictError,
  ConnectionError,
  OutcomeUnknownError,
} from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

type RetryMode = "never" | "safe";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
  requestId?: string;
  retry?: RetryMode;
  signal?: AbortSignal;
  outcomeUnknown?: boolean;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
  requestId?: string;
}

export const paginationQuery = (options?: ListOptions): string => {
  if (options)
    requireKnownKeys(
      options,
      ["limit", "cursor", "signal", "requestId"],
      "List options",
    );
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set("limit", String(options.limit));
  if (options?.cursor !== undefined) query.set("cursor", options.cursor);
  return query.size ? `?${query}` : "";
};

export function requireCreationKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  )
    throw new TypeError(
      "Creation requires a stable idempotencyKey (1-128 safe characters)",
    );
}

export interface HttpResult<T> {
  data: T;
  etag: string | undefined;
  requestId: string;
}

export const requireEtag = <T>(result: HttpResult<T>): string => {
  if (!result.etag) {
    throw new TiDBLinkError("TiDB Link response omitted a required ETag", {
      requestId: result.requestId,
    });
  }
  return result.etag;
};

const requestId = (): string => crypto.randomUUID();
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const sleep = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
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

const pauseBeforeRetry = async (
  milliseconds: number,
  options: RequestOptions,
  requestId: string,
): Promise<void> => {
  try {
    await sleep(milliseconds, options.signal);
  } catch (cause) {
    if (!options.outcomeUnknown) throw cause;
    throw new OutcomeUnknownError(
      "TiDB Link request outcome is unknown after local waiting stopped; recover with the same creation key",
      { requestId, cause },
    );
  }
};

const errorInput = async (
  response: Response,
  fallbackRequestId: string,
): Promise<ConstructorParameters<typeof TiDBLinkApiError>[0]> => {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  const envelope = value as {
    error?: {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      requestId?: unknown;
    };
  };
  const error =
    typeof envelope?.error === "object" && envelope.error !== null
      ? envelope.error
      : undefined;
  return {
    status: response.status,
    code: typeof error?.code === "string" ? error.code : "http_error",
    message:
      typeof error?.message === "string"
        ? error.message
        : `TiDB Link request failed with status ${response.status}`,
    requestId:
      response.headers.get("x-request-id") ??
      (typeof error?.requestId === "string"
        ? error.requestId
        : fallbackRequestId),
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

export function requireKnownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`${label}.${unknown} is not supported`);
}

/** Check the frozen wire grammar without retaining or exposing the credential. */
export const isApiKey = (
  value: unknown,
  kind: "org" | "user",
): value is string => {
  if (typeof value !== "string") return false;
  const match = /^ti_(org|user)_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43}$/u.exec(
    value,
  );
  return match !== null && match[0] === value && match[1] === kind;
};

export class HttpClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(input: { baseUrl: string; apiKey: string }) {
    this.#baseUrl = normalizeBaseUrl(input.baseUrl);
    this.#apiKey = input.apiKey;
  }

  #headers(
    options: RequestOptions,
    stableRequestId: string,
  ): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      "x-request-id": stableRequestId,
      ...(options.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    };
  }

  get<T>(
    path: string,
    options?: Pick<RequestOptions, "signal" | "requestId">,
  ): Promise<T> {
    return this.request(path, { ...options, retry: "safe" });
  }

  getResponse<T>(
    path: string,
    options?: Pick<RequestOptions, "signal" | "requestId">,
  ): Promise<HttpResult<T>> {
    return this.response(path, { ...options, retry: "safe" });
  }

  post<T>(
    path: string,
    body: unknown,
    options?: Pick<
      RequestOptions,
      "outcomeUnknown" | "requestId" | "signal"
    > & {
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
    options: Pick<
      RequestOptions,
      "ifMatch" | "outcomeUnknown" | "requestId" | "signal"
    >,
  ): Promise<HttpResult<T>> {
    return this.response(path, { ...options, method: "PATCH", body });
  }

  put<T>(
    path: string,
    body: unknown,
    options?: Pick<RequestOptions, "outcomeUnknown" | "requestId" | "signal">,
  ): Promise<T> {
    return this.request(path, { ...options, method: "PUT", body });
  }

  deleteResponse<T>(
    path: string,
    options?: Pick<RequestOptions, "outcomeUnknown" | "requestId" | "signal">,
  ): Promise<HttpResult<T>> {
    return this.response(path, { ...options, method: "DELETE" });
  }

  delete<T>(
    path: string,
    options?: Pick<RequestOptions, "outcomeUnknown" | "requestId" | "signal">,
  ): Promise<T> {
    return this.request(path, { ...options, method: "DELETE" });
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.response<T>(path, options)).data;
  }

  async response<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResult<T>> {
    const stableRequestId = options.requestId ?? requestId();
    if (!REQUEST_ID.test(stableRequestId)) {
      throw new TypeError("requestId must be 1-64 safe characters");
    }
    if (
      options.idempotencyKey !== undefined &&
      (options.idempotencyKey.length > 255 ||
        !/^[\x20-\x7e]+$/.test(options.idempotencyKey))
    ) {
      throw new TypeError(
        "idempotencyKey must be 1-255 visible ASCII characters",
      );
    }
    options.signal?.throwIfAborted();
    const attempts = options.retry === "safe" ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.#baseUrl}${path}`, {
          method: options.method ?? "GET",
          redirect: "error",
          headers: this.#headers(options, stableRequestId),
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (cause) {
        if (options.signal?.aborted && !options.outcomeUnknown) throw cause;
        if (attempt < attempts && !options.signal?.aborted) {
          await pauseBeforeRetry(
            100 * 2 ** (attempt - 1),
            options,
            stableRequestId,
          );
          continue;
        }
        const ErrorClass = options.outcomeUnknown
          ? OutcomeUnknownError
          : ConnectionError;
        throw new ErrorClass(
          options.outcomeUnknown
            ? "TiDB Link request outcome is unknown; do not repeat it automatically"
            : "Could not reach TiDB Link",
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
            const ErrorClass = options.outcomeUnknown
              ? OutcomeUnknownError
              : TiDBLinkError;
            throw new ErrorClass(
              options.outcomeUnknown
                ? "TiDB Link accepted the request but returned an unusable response"
                : "TiDB Link returned invalid JSON",
              {
                requestId:
                  response.headers.get("x-request-id") ?? stableRequestId,
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
        await response.arrayBuffer().catch(() => undefined);
        await pauseBeforeRetry(
          100 * 2 ** (attempt - 1),
          options,
          stableRequestId,
        );
        continue;
      }

      const input = await errorInput(response, stableRequestId);
      const error =
        input.status === 409 || input.status === 412
          ? new ConflictError(input)
          : new TiDBLinkApiError(input);
      if (
        options.outcomeUnknown &&
        (input.status >= 500 || input.status === 408)
      ) {
        throw new OutcomeUnknownError(
          "TiDB Link could not confirm the mutation outcome",
          {
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            cause: error,
          },
        );
      }
      throw error;
    }
    throw new Error("unreachable");
  }
}
