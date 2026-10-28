import {
  HttpClient,
  requireKnownKeys,
  paginationQuery,
  type ListOptions,
  type HttpResult,
} from "./http.js";
import { OutcomeUnknownError, TiDBLinkError } from "./errors.js";
import type { RequestOptions } from "./organization.js";

export type SchedulerSchedule =
  | { kind: "once"; runAt: string; after?: never }
  | { kind: "once"; after: string; runAt?: never }
  | { kind: "cron"; cronExpr: string; timezone: string };
export type SchedulerDelivery =
  | { target: "new_session" }
  | { target: "bound_session"; sessionId: string };
export type CreateSchedulerInput = RequestOptions & {
  idempotencyKey: string;
  title: string;
  prompt: string;
  schedule: SchedulerSchedule;
  validFrom?: string | null;
  validUntil?: string | null;
} & (
    | { agentId: string; delivery?: { target: "new_session" } }
    | {
        agentId?: never;
        delivery: { target: "bound_session"; sessionId: string };
      }
  );
export interface UpdateSchedulerInput {
  title?: string;
  prompt?: string;
  agentId?: string;
  delivery?: SchedulerDelivery;
  schedule?: SchedulerSchedule;
  enabled?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
  snoozeUntil?: string;
}
export interface Scheduler {
  schedulerId: string;
  ownerUserId: string;
  organizationId: string;
  agentId: string;
  title: string;
  prompt: string;
  delivery: {
    target: "new_session" | "bound_session";
    sessionId: string | null;
  };
  schedule: {
    kind: "once" | "cron";
    cronExpr: string | null;
    runAt: string | null;
    timezone: string;
  };
  validFrom: string | null;
  validUntil: string | null;
  status: "enabled" | "disabled";
  nextFireAt: string | null;
  lastFiredAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SchedulerResponse {
  scheduler: Scheduler;
  etag: string;
}
export interface SchedulerPage {
  schedulers: Scheduler[];
  nextCursor: string | null;
}
export interface SchedulerListOptions extends ListOptions {
  status?: "enabled" | "disabled";
}
export interface SchedulerMutationOptions extends RequestOptions {
  ifMatch: string;
}
export interface SchedulerFire {
  fireId: string;
  schedulerId: string;
  scheduledFor: string;
  executionStatus: "pending" | "completed" | "failed";
  execution: {
    agentId: string;
    prompt: string;
    delivery: Scheduler["delivery"];
  };
  result: {
    sessionId: string | null;
    turnId: string | null;
    messageId: string | null;
    failureCode: string | null;
  };
  createdAt: string;
  settledAt: string | null;
}
export interface SchedulerFirePage {
  fires: SchedulerFire[];
  nextCursor: string | null;
}

const requireMatch = (options: SchedulerMutationOptions): void => {
  requireKnownKeys(
    options,
    ["ifMatch", "signal", "requestId"],
    "Scheduler mutation options",
  );
  if (typeof options.ifMatch !== "string" || !options.ifMatch)
    throw new TypeError(
      "Scheduler mutation requires the previously read ifMatch ETag",
    );
};

const path = (id: string) => `/api/v1/schedulers/${encodeURIComponent(id)}`;
const receipt = (
  result: HttpResult<{ scheduler?: Scheduler }>,
  mutation = true,
): SchedulerResponse => {
  const scheduler = result.data?.scheduler;
  if (
    !scheduler?.schedulerId ||
    !result.etag ||
    !Number.isSafeInteger(scheduler.revision)
  ) {
    const ErrorClass = mutation ? OutcomeUnknownError : TiDBLinkError;
    throw new ErrorClass(
      "Scheduler response omitted its identity or ETag; read the original Scheduler before changing it",
      { requestId: result.requestId },
    );
  }
  return { scheduler, etag: result.etag };
};

export class UserSchedulers {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  async create(input: CreateSchedulerInput): Promise<SchedulerResponse> {
    requireKnownKeys(
      input,
      [
        "idempotencyKey",
        "title",
        "prompt",
        "schedule",
        "agentId",
        "delivery",
        "validFrom",
        "validUntil",
        "requestId",
        "signal",
      ],
      "Scheduler creation",
    );
    if (
      typeof input.idempotencyKey !== "string" ||
      !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)
    )
      throw new TypeError(
        "Scheduler creation requires a stable idempotencyKey (1-255 visible ASCII characters)",
      );
    const { idempotencyKey, requestId, signal, ...body } = input;
    return receipt(
      await this.#http.postResponse("/api/v1/schedulers", body, {
        idempotencyKey,
        outcomeUnknown: true,
        ...(requestId ? { requestId } : {}),
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async get(
    schedulerId: string,
    options?: RequestOptions,
  ): Promise<SchedulerResponse> {
    return receipt(
      await this.#http.getResponse(path(schedulerId), options),
      false,
    );
  }

  async update(
    schedulerId: string,
    input: UpdateSchedulerInput,
    options: SchedulerMutationOptions,
  ): Promise<SchedulerResponse> {
    requireKnownKeys(
      input,
      [
        "title",
        "prompt",
        "agentId",
        "delivery",
        "schedule",
        "enabled",
        "validFrom",
        "validUntil",
        "snoozeUntil",
      ],
      "Scheduler update",
    );
    requireMatch(options);
    return receipt(
      await this.#http.patchResponse(path(schedulerId), input, {
        ...options,
        outcomeUnknown: true,
      }),
    );
  }

  async delete(
    schedulerId: string,
    options: SchedulerMutationOptions,
  ): Promise<void> {
    requireMatch(options);
    await this.#http.response(path(schedulerId), {
      ...options,
      method: "DELETE",
      outcomeUnknown: true,
    });
  }

  list(options: SchedulerListOptions = {}): Promise<SchedulerPage> {
    requireKnownKeys(
      options,
      ["status", "limit", "cursor", "signal", "requestId"],
      "Scheduler list options",
    );
    const { status, ...paging } = options;
    const query = new URLSearchParams(paginationQuery(paging).slice(1));
    if (status !== undefined) query.set("status", status);
    return this.#http.get(
      `/api/v1/schedulers${query.size ? `?${query}` : ""}`,
      options,
    );
  }

  fires(
    schedulerId: string,
    options?: ListOptions,
  ): Promise<SchedulerFirePage> {
    return this.#http.get(
      `${path(schedulerId)}/fires${paginationQuery(options)}`,
      options,
    );
  }
}
