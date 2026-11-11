import { OutcomeUnknownError, TiDBLinkError } from "./errors.js";
import {
  HttpClient,
  paginationQuery,
  requireCreationKey,
  requireKnownKeys,
  requestOptions,
  sleep,
  type HttpResult,
  type ListOptions,
} from "./http.js";
import type { RequestOptions } from "./organization.js";

export interface SkillSummary {
  skillId: string;
  name: string;
  description: string;
  revision: number;
  /** The latest published version. */
  headVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersion {
  version: number;
  name: string;
  description: string;
  packageDigest: string;
  rawSize: number;
  extractedSize: number;
  loadable: boolean;
  portable: boolean;
  createdAt: string;
}

export interface SkillPage {
  skills: SkillSummary[];
  nextCursor: string | null;
}

/** A Skill with one page of its published versions, newest first. */
export interface SkillDetail {
  skill: SkillSummary;
  versions: SkillVersion[];
  nextCursor: string | null;
}

export type SkillUploadState =
  | "uploading"
  | "pending"
  | "uploaded"
  | "fetching"
  | "validating"
  | "extracting"
  | "awaiting_confirmation"
  | "finalizing"
  | "done"
  | "failed"
  | "aborted";

/**
 * A Skill ZIP being validated and published. It reaches
 * `awaiting_confirmation` once valid, then `done` with a `version` after
 * publication; `failed` and `aborted` are final.
 */
export interface SkillUpload {
  uploadId: string;
  /** Every upload creates a new Skill. */
  skillId: string;
  state: SkillUploadState;
  byteSize: number;
  sha256: string;
  /** Publish before this time. */
  expiresAt: string | null;
  validation: {
    entriesTotal: number | null;
    fileCount: number | null;
    entriesDone: number;
    declaredBytes: number | null;
    bytesDone: number;
    diagnostics: Record<string, unknown>[];
    failureCode: string | null;
    failurePath: string | null;
  };
  /** The published version once `state` is `done`. */
  version: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadSkillInput extends RequestOptions {
  /** The Skill package as a ZIP archive (at most 200 MiB). */
  bytes: Uint8Array;
  /** Repeating the same bytes with the same key returns the original upload. */
  idempotencyKey: string;
}

export interface PublishSkillOptions extends RequestOptions {
  /** Repeating publication with the same key returns the same upload. */
  idempotencyKey: string;
}

export interface WaitForSkillUploadOptions extends RequestOptions {
  /** Stop waiting at one of these states. Defaults to `awaiting_confirmation`, `done`, `failed` and `aborted`. */
  until?: readonly SkillUploadState[];
  /** Local wait limit; default 120 seconds. */
  timeoutMs?: number;
  /** Delay between reads; default 1 second. */
  intervalMs?: number;
}

const SETTLED: readonly SkillUploadState[] = [
  "awaiting_confirmation",
  "done",
  "failed",
  "aborted",
];

const uploadPath = (id: string) =>
  `/skills/uploads/${encodeURIComponent(id)}`;

const uploadReceipt = (
  result: HttpResult<{ upload?: SkillUpload }>,
): SkillUpload => {
  if (
    typeof result.data?.upload?.uploadId !== "string" ||
    !result.data.upload.uploadId
  )
    throw new OutcomeUnknownError(
      "Skill upload returned no usable state; repeat it with the same idempotency key",
      { requestId: result.requestId },
    );
  return result.data.upload;
};

/** Organization Skills that Templates can reference by `skillId` and `version`. */
export class Skills {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Published, loadable Organization Skills. */
  list(options?: ListOptions): Promise<SkillPage> {
    return this.#http.get(`/skills${paginationQuery(options)}`, options);
  }

  /** A Skill and its published versions, newest first. */
  get(skillId: string, options?: ListOptions): Promise<SkillDetail> {
    return this.#http.get(
      `/skills/${encodeURIComponent(skillId)}${paginationQuery(options)}`,
      options,
    );
  }

  /** Upload a Skill ZIP for validation. It is not published until `publish`. */
  async upload(input: UploadSkillInput): Promise<SkillUpload> {
    requireKnownKeys(
      input,
      ["bytes", "idempotencyKey", "signal", "requestId"],
      "Skill upload",
    );
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0)
      throw new TypeError("Skill upload requires the ZIP bytes");
    requireCreationKey(input.idempotencyKey);
    const { response, requestId } = await this.#http.rawResponse(
      "/skills/uploads",
      {
        method: "POST",
        body: Uint8Array.from(input.bytes),
        headers: { "content-type": "application/octet-stream" },
        idempotencyKey: input.idempotencyKey,
        retry: "safe",
        outcomeUnknown: true,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
    );
    let data: { upload?: SkillUpload };
    try {
      data = (await response.json()) as { upload?: SkillUpload };
    } catch (cause) {
      throw new OutcomeUnknownError(
        "Skill upload returned an unusable response; repeat it with the same idempotency key",
        { requestId, cause },
      );
    }
    return uploadReceipt({ data, etag: undefined, requestId });
  }

  async getUpload(
    uploadId: string,
    options?: RequestOptions,
  ): Promise<SkillUpload> {
    const response = await this.#http.get<{ upload: SkillUpload }>(
      uploadPath(uploadId),
      requestOptions(options),
    );
    return response.upload;
  }

  /** Read the upload until it reaches a settled state. */
  async waitForUpload(
    uploadId: string,
    options: WaitForSkillUploadOptions = {},
  ): Promise<SkillUpload> {
    requireKnownKeys(
      options,
      ["until", "timeoutMs", "intervalMs", "signal", "requestId"],
      "Skill upload wait options",
    );
    const { until = SETTLED, timeoutMs = 120_000, intervalMs = 1_000 } =
      options;
    for (const value of [timeoutMs, intervalMs])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError("Wait durations must be non-negative integers");
    const deadline = Date.now() + timeoutMs;
    const request = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    };
    while (true) {
      const upload = await this.getUpload(uploadId, request);
      if (until.includes(upload.state)) return upload;
      if (Date.now() + intervalMs > deadline)
        throw new TiDBLinkError(
          `Skill upload is still ${upload.state}; read it again later`,
        );
      await sleep(intervalMs, options.signal);
    }
  }

  /** Cancel an upload that is not published. */
  async cancelUpload(uploadId: string, options?: RequestOptions): Promise<void> {
    await this.#http.deleteResponse(uploadPath(uploadId), {
      ...requestOptions(options),
      outcomeUnknown: true,
    });
  }

  /**
   * Publish a validated upload as the Skill's next version. Publication
   * finishes asynchronously: wait for `done` to read the `version`.
   */
  async publish(
    uploadId: string,
    options: PublishSkillOptions,
  ): Promise<SkillUpload> {
    requireKnownKeys(
      options,
      ["idempotencyKey", "signal", "requestId"],
      "Skill publication options",
    );
    requireCreationKey(options.idempotencyKey);
    const { idempotencyKey, ...request } = options;
    return uploadReceipt(
      await this.#http.postResponse<{ upload?: SkillUpload }>(
        `${uploadPath(uploadId)}/publish`,
        undefined,
        { idempotencyKey, idempotent: true, outcomeUnknown: true, ...request },
      ),
    );
  }
}
