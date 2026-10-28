import { HttpClient, requireKnownKeys } from "./http.js";
import {
  OutcomeUnknownError,
  TiDBLinkError,
  TiDBLinkApiError,
  ConnectionError,
} from "./errors.js";
import type { RequestOptions } from "./organization.js";

export interface UserFile {
  fileId: string;
  originalName: string;
  status: "uploading" | "ready" | "failed";
  byteSize: number | null;
  sha256: string | null;
  checksumVerification: "whole" | "part_only" | null;
  contentType: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  source:
    | { kind: "user_upload" }
    | {
        kind: "artifact_revision";
        artifactId: string;
        revisionId: string;
        revisionNumber: number;
        sessionId: string;
        turnId: string | null;
        operationId: string | null;
      };
}

export interface FileUploadCapabilities {
  protocol: "tidb-link.user-files.v2";
  inlineThreshold: number;
  maxUploadBytes: number;
  checksum: "sha-256";
}

export interface CreateFileUploadInput extends RequestOptions {
  idempotencyKey: string;
  originalName: string;
  byteSize: number;
  sha256: string;
  contentType: string | null;
}

export interface UploadFileInput extends RequestOptions {
  /** Persist with the original input before upload; reuse only for that exact file. */
  idempotencyKey: string;
  originalName: string;
  bytes: Uint8Array;
  contentType?: string | null;
}

export interface FileUpload {
  uploadId: string;
  file: UserFile;
  mode: "tidb-link" | "s3";
  expectedChecksumVerification: "whole";
  expiresAt: string;
  contentUrl?: string;
  uploadUrl?: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
  partSize?: number;
  totalParts?: number;
}

export interface FileUploadStatus {
  uploadId: string;
  file: UserFile;
  mode: "tidb-link" | "s3" | "initializing";
  state: "active" | "completing" | "aborting" | "completed" | "aborted";
  expiresAt: string;
}

export interface FileUploadPart {
  number: number;
  url: string;
  size: number;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface FileListOptions extends RequestOptions {
  history?: boolean;
  limit?: number;
  cursor?: string;
}
export interface FilePage {
  files: UserFile[];
  nextCursor: string | null;
}
export interface FileDownloadGrant {
  url: string;
  expiresAt: string;
  byteSize: number;
  sha256: string;
}
export type FileContent =
  | { type: "bytes"; bytes: Uint8Array; contentType: string }
  | { type: "download"; grant: FileDownloadGrant };

export interface UploadedFilePart {
  number: number;
  etag: string;
  sha256: string;
}

export class FileUploadOutcomeUnknownError extends OutcomeUnknownError {
  constructor(
    readonly idempotencyKey: string,
    readonly uploadId: string | undefined,
    cause: OutcomeUnknownError,
  ) {
    super(
      "File upload outcome is unknown; recover the original upload before transferring again",
      { ...(cause.requestId ? { requestId: cause.requestId } : {}), cause },
    );
  }
}

const uploadPath = (id: string) =>
  `/api/v1/user/drive/uploads/${encodeURIComponent(id)}`;
const digest = async (bytes: Uint8Array) => {
  const value = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
  );
  return {
    hex: Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
    base64: btoa(String.fromCharCode(...value)),
  };
};
const fileReceipt = (
  value: { file?: UserFile },
  requestId: string,
): UserFile => {
  if (
    !value?.file?.fileId ||
    !["uploading", "ready", "failed"].includes(value.file.status)
  ) {
    throw new OutcomeUnknownError(
      "File operation returned no usable File; read the upload state",
      { requestId },
    );
  }
  return value.file;
};
const requireReady = (
  file: UserFile,
  byteSize: number,
  sha256: string,
): UserFile => {
  if (
    file.status !== "ready" ||
    file.byteSize !== byteSize ||
    file.sha256 !== sha256 ||
    file.checksumVerification !== "whole"
  ) {
    throw new TiDBLinkError(
      "File is not ready with the expected complete size and checksum",
    );
  }
  return file;
};

const requireActiveGrant = (expiresAt: string): void => {
  if (
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  )
    throw new TiDBLinkApiError({
      status: 410,
      code: "file_transfer_expired",
      message:
        "File transfer credential expired; obtain a fresh credential for the original file",
    });
};
const transferUrl = (url: URL): URL => {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TypeError(
      "File transfer URL must be HTTP(S) without embedded credentials or a fragment",
    );
  return url;
};

export class UserFiles {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async capabilities(
    options?: RequestOptions,
  ): Promise<FileUploadCapabilities> {
    return (
      await this.#http.get<{ capabilities: FileUploadCapabilities }>(
        "/api/v1/user/drive/upload-capabilities",
        options,
      )
    ).capabilities;
  }

  async createUpload(input: CreateFileUploadInput): Promise<FileUpload> {
    requireKnownKeys(
      input,
      [
        "idempotencyKey",
        "originalName",
        "byteSize",
        "sha256",
        "contentType",
        "signal",
        "requestId",
      ],
      "File upload",
    );
    if (
      typeof input.idempotencyKey !== "string" ||
      !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)
    )
      throw new TypeError(
        "File upload requires a stable idempotencyKey (1-255 visible ASCII characters)",
      );
    if (
      typeof input.originalName !== "string" ||
      !input.originalName ||
      input.originalName.length > 255 ||
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 0 ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !(
        input.contentType === null ||
        (typeof input.contentType === "string" &&
          input.contentType.length <= 255)
      )
    )
      throw new TypeError(
        "File upload requires a name, nonnegative byteSize, complete SHA-256 and nullable contentType",
      );
    const { idempotencyKey, signal, requestId, ...body } = input;
    const result = await this.#http.postResponse<{ upload?: FileUpload }>(
      "/api/v1/user/drive/uploads",
      body,
      {
        idempotencyKey,
        outcomeUnknown: true,
        ...(signal ? { signal } : {}),
        ...(requestId ? { requestId } : {}),
      },
    );
    const upload = result.data?.upload;
    if (
      !upload?.uploadId ||
      upload.file?.fileId !== upload.uploadId ||
      !["tidb-link", "s3"].includes(upload.mode) ||
      !Number.isFinite(Date.parse(upload.expiresAt)) ||
      upload.expectedChecksumVerification !== "whole"
    )
      throw new OutcomeUnknownError(
        "File creation returned no usable upload; replay the same creation identity",
        { requestId: result.requestId },
      );
    return upload;
  }

  async getUpload(
    uploadId: string,
    options?: RequestOptions,
  ): Promise<FileUploadStatus> {
    return (
      await this.#http.get<{ upload: FileUploadStatus }>(
        uploadPath(uploadId),
        options,
      )
    ).upload;
  }

  async uploadContent(
    uploadId: string,
    bytes: Uint8Array,
    options?: RequestOptions,
  ): Promise<UserFile> {
    const checksum = await digest(bytes);
    const { response, requestId } = await this.#http.rawResponse(
      `${uploadPath(uploadId)}/content`,
      {
        ...options,
        method: "PUT",
        body: Uint8Array.from(bytes),
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "content-digest": `sha-256=:${checksum.base64}:`,
        },
        outcomeUnknown: true,
      },
    );
    try {
      return fileReceipt(await response.json(), requestId);
    } catch (cause) {
      if (cause instanceof OutcomeUnknownError) throw cause;
      throw new OutcomeUnknownError(
        "Inline transfer returned no usable File; read the upload state",
        { requestId, cause },
      );
    }
  }

  async presignPart(
    uploadId: string,
    number: number,
    sha256: string,
    options?: RequestOptions,
  ): Promise<FileUploadPart> {
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      throw new TypeError("A part requires a positive number and SHA-256");
    const result = await this.#http.postResponse<{ part?: FileUploadPart }>(
      `${uploadPath(uploadId)}/parts/${number}/presign`,
      { sha256 },
      { ...options, outcomeUnknown: true },
    );
    const part = result.data?.part;
    if (
      part?.number !== number ||
      !Number.isSafeInteger(part.size) ||
      part.size < 0 ||
      !part.url ||
      !part.headers ||
      !Number.isFinite(Date.parse(part.expiresAt))
    )
      throw new OutcomeUnknownError(
        "Part signing returned no usable grant; reconcile before transferring",
        { requestId: result.requestId },
      );
    return part;
  }

  async uploadPart(
    part: FileUploadPart,
    bytes: Uint8Array,
    options?: RequestOptions,
  ): Promise<UploadedFilePart> {
    if (bytes.byteLength !== part.size)
      throw new TypeError("Part bytes do not match the signed size");
    const checksum = await digest(bytes);
    const signedChecksum = new Headers(part.headers).get(
      "x-amz-checksum-sha256",
    );
    if (signedChecksum !== checksum.base64)
      throw new TypeError("Part bytes do not match the signed checksum");
    const response = await this.transfer(part.url, part.expiresAt, {
      method: "PUT",
      headers: { ...part.headers, "content-length": String(bytes.byteLength) },
      body: Uint8Array.from(bytes),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const etag = response.headers.get("etag");
    await response.body?.cancel();
    if (!etag)
      throw new OutcomeUnknownError(
        "Part transfer returned no ETag; reconcile before completing",
      );
    return { number: part.number, etag, sha256: checksum.hex };
  }

  private async transfer(
    url: string,
    expiresAt: string,
    init: RequestInit,
  ): Promise<Response> {
    requireActiveGrant(expiresAt);
    const destination = transferUrl(this.#http.resolveUrl(url));
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(destination, { ...init, redirect: "error" });
    } catch {
      throw new OutcomeUnknownError(
        "File transfer outcome is unknown; inspect the original upload",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 500 || response.status === 408)
        throw new OutcomeUnknownError(
          "File transfer outcome is unknown; inspect the original upload",
        );
      throw new TiDBLinkApiError({
        status: response.status,
        code: "file_transfer_failed",
        message: "File byte transfer was refused",
      });
    }
    return response;
  }

  async completeUpload(
    uploadId: string,
    parts?: UploadedFilePart[],
    options?: RequestOptions,
  ): Promise<UserFile> {
    const result = await this.#http.postResponse<{ file?: UserFile }>(
      `${uploadPath(uploadId)}/complete`,
      parts === undefined ? {} : { parts },
      { ...options, outcomeUnknown: true },
    );
    return fileReceipt(result.data, result.requestId);
  }

  async cancelUpload(
    uploadId: string,
    options?: RequestOptions,
  ): Promise<UserFile> {
    const result = await this.#http.deleteResponse<{ file?: UserFile }>(
      uploadPath(uploadId),
      { ...options, outcomeUnknown: true },
    );
    return fileReceipt(result.data, result.requestId);
  }

  async upload(input: UploadFileInput): Promise<UserFile> {
    requireKnownKeys(
      input,
      [
        "idempotencyKey",
        "originalName",
        "bytes",
        "contentType",
        "signal",
        "requestId",
      ],
      "File upload",
    );
    if (!(input.bytes instanceof Uint8Array))
      throw new TypeError("File bytes must be a Uint8Array");
    const { bytes: source, ...metadata } = input;
    const bytes = Uint8Array.from(source);
    const checksum = await digest(bytes);
    const options = {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
    let uploadId: string | undefined;
    try {
      const upload = await this.createUpload({
        ...metadata,
        contentType: input.contentType ?? null,
        byteSize: bytes.byteLength,
        sha256: checksum.hex,
      });
      uploadId = upload.uploadId;
      if (upload.file.status === "ready")
        return requireReady(upload.file, bytes.byteLength, checksum.hex);
      requireActiveGrant(upload.expiresAt);
      let parts: UploadedFilePart[] | undefined;
      if (upload.mode === "tidb-link") {
        if (upload.uploadUrl) {
          const grant = upload.uploadUrl;
          if (
            grant.method !== "PUT" ||
            new Headers(grant.headers).get("content-digest") !==
              `sha-256=:${checksum.base64}:`
          )
            throw new TiDBLinkError(
              "Inline upload grant does not match the complete file checksum",
            );
          const response = await this.transfer(grant.url, grant.expiresAt, {
            method: "PUT",
            headers: {
              ...grant.headers,
              "content-length": String(bytes.byteLength),
            },
            body: bytes,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          await response.body?.cancel();
        } else await this.uploadContent(uploadId, bytes, options);
      } else {
        const { partSize, totalParts } = upload;
        if (
          !partSize ||
          !Number.isSafeInteger(partSize) ||
          !Number.isSafeInteger(totalParts) ||
          totalParts !== Math.ceil(bytes.byteLength / partSize)
        )
          throw new TiDBLinkError(
            "Multipart upload plan does not cover the complete file",
          );
        parts = [];
        for (let number = 1; number <= totalParts!; number++) {
          const partBytes = bytes.subarray(
            (number - 1) * partSize,
            number * partSize,
          );
          const part = await this.presignPart(
            uploadId,
            number,
            (await digest(partBytes)).hex,
            options,
          );
          parts.push(await this.uploadPart(part, partBytes, options));
        }
      }
      return requireReady(
        await this.completeUpload(uploadId, parts, options),
        bytes.byteLength,
        checksum.hex,
      );
    } catch (cause) {
      if (cause instanceof OutcomeUnknownError)
        throw new FileUploadOutcomeUnknownError(
          input.idempotencyKey,
          uploadId,
          cause,
        );
      throw cause;
    }
  }

  list(options: FileListOptions = {}): Promise<FilePage> {
    requireKnownKeys(
      options,
      ["history", "limit", "cursor", "signal", "requestId"],
      "File list options",
    );
    const query = new URLSearchParams();
    if (options.history !== undefined)
      query.set("history", String(options.history));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    return this.#http.get(
      `/api/v1/files${query.size ? `?${query}` : ""}`,
      options,
    );
  }

  async get(fileId: string, options?: RequestOptions): Promise<UserFile> {
    return (
      await this.#http.get<{ file: UserFile }>(
        `/api/v1/files/${encodeURIComponent(fileId)}`,
        options,
      )
    ).file;
  }

  async getContent(
    fileId: string,
    options?: RequestOptions,
  ): Promise<FileContent> {
    const { response, requestId } = await this.#http.rawResponse(
      `/api/v1/files/${encodeURIComponent(fileId)}/content`,
      options,
    );
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    try {
      if (
        contentType.split(";")[0]?.trim().toLowerCase() ===
        "application/vnd.tidb-link.file-download+json"
      ) {
        const grant: FileDownloadGrant = await response.json();
        if (
          !grant?.url ||
          !Number.isSafeInteger(grant.byteSize) ||
          grant.byteSize < 0 ||
          !/^[a-f0-9]{64}$/.test(grant.sha256) ||
          !Number.isFinite(Date.parse(grant.expiresAt))
        )
          throw new TiDBLinkError(
            "File content returned no usable download grant",
            { requestId },
          );
        return { type: "download", grant };
      }
      return {
        type: "bytes",
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType,
      };
    } catch (cause) {
      if (cause instanceof TiDBLinkError) throw cause;
      throw new ConnectionError("File content could not be read completely", {
        requestId,
      });
    }
  }

  async downloadFromGrant(
    grant: FileDownloadGrant,
    options?: RequestOptions,
  ): Promise<Uint8Array> {
    requireActiveGrant(grant.expiresAt);
    let destination = transferUrl(this.#http.resolveUrl(grant.url));
    options?.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(destination, {
        redirect: "manual",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new TiDBLinkError(
            "File download redirect omitted its destination",
          );
        destination = transferUrl(new URL(location, destination));
        if (destination.protocol !== "https:")
          throw new TiDBLinkError("File download redirect requires HTTPS");
        response = await fetch(destination, {
          redirect: "error",
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      }
    } catch (cause) {
      if (cause instanceof TiDBLinkError) throw cause;
      throw new ConnectionError("File download could not be reached");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TiDBLinkApiError({
        status: response.status,
        code: "file_download_failed",
        message:
          "File download was refused; obtain a fresh credential if it expired",
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new ConnectionError(
        "File download ended before the complete body arrived",
      );
    }
    if (
      bytes.byteLength !== grant.byteSize ||
      (await digest(bytes)).hex !== grant.sha256
    )
      throw new TiDBLinkError(
        "Downloaded file does not match its complete size and checksum",
      );
    return bytes;
  }

  async download(
    fileId: string,
    options?: RequestOptions,
  ): Promise<Uint8Array> {
    const file = await this.get(fileId, options);
    if (
      file.status !== "ready" ||
      file.byteSize === null ||
      file.sha256 === null ||
      file.checksumVerification !== "whole"
    )
      throw new TiDBLinkError(
        "Only a ready, whole-file verified File can be downloaded",
      );
    const content = await this.getContent(fileId, options);
    if (content.type === "download") {
      if (
        content.grant.byteSize !== file.byteSize ||
        content.grant.sha256 !== file.sha256
      )
        throw new TiDBLinkError(
          "Download grant does not match the selected File",
        );
      return this.downloadFromGrant(content.grant, options);
    }
    if (
      content.bytes.byteLength !== file.byteSize ||
      (await digest(content.bytes)).hex !== file.sha256
    )
      throw new TiDBLinkError(
        "Downloaded file does not match its complete size and checksum",
      );
    return content.bytes;
  }
}
