import { OutcomeUnknownError } from "./errors.js";
import {
  HttpClient,
  requireKnownKeys,
  requestOptions,
  type HttpResult,
} from "./http.js";
import type { RequestOptions } from "./organization.js";

export type ConnectorTransport = "streamable_http" | "tunnel";

/** An Organization-owned MCP tool server that Agents can call. */
export interface Connector {
  connectorId: string;
  organizationId: string;
  displayName: string;
  /** The HTTPS MCP endpoint of a `streamable_http` Connector. */
  endpointUrl: string;
  endpointVersion: number;
  transport: ConnectorTransport;
  status: "inactive" | "active";
  /** Pass this as `expectedConnectorVersion` to change the registration. */
  connectorVersion: number;
  createdAt: string;
  updatedAt: string;
  /** What activation discovered at the endpoint. */
  observation?: {
    era: "modern" | "legacy";
    protocolVersion: string;
    endpointVersion: number;
    probedAt: string;
    expiresAt: string;
  };
}

export interface RegisterConnectorInput extends RequestOptions {
  /** Unique within the Organization. */
  displayName: string;
  /** Defaults to `streamable_http`. */
  transport?: ConnectorTransport;
  /** Required for `streamable_http`: an HTTPS URL without credentials. */
  endpointUrl?: string;
}

export interface UpdateConnectorInput {
  displayName?: string;
  endpointUrl?: string;
}

export interface ConnectorVersionOptions extends RequestOptions {
  /** The `connectorVersion` you read. A changed registration is refused with ConflictError. */
  expectedConnectorVersion: number;
}

const connectorPath = (id: string) => `/connectors/${encodeURIComponent(id)}`;

const connectorReceipt = (result: HttpResult<Connector>): Connector => {
  if (typeof result.data?.connectorId !== "string" || !result.data.connectorId)
    throw new OutcomeUnknownError(
      "Connector change returned no usable registration; read it before changing it again",
      { requestId: result.requestId },
    );
  return result.data;
};

const requireVersion = (options: ConnectorVersionOptions, label: string) => {
  requireKnownKeys(
    options,
    ["expectedConnectorVersion", "signal", "requestId"],
    `${label} options`,
  );
  if (
    !Number.isSafeInteger(options.expectedConnectorVersion) ||
    options.expectedConnectorVersion < 0
  )
    throw new TypeError(`${label} requires expectedConnectorVersion`);
};

/**
 * Organization Connector registrations. Register a Connector, then activate
 * it: activation connects to the endpoint and discovers its tools. Edit only
 * an inactive Connector.
 */
export class Connectors {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async list(options?: RequestOptions): Promise<Connector[]> {
    const response = await this.#http.get<{ connectors: Connector[] }>(
      "/connectors",
      requestOptions(options),
    );
    return response.connectors;
  }

  get(connectorId: string, options?: RequestOptions): Promise<Connector> {
    return this.#http.get(connectorPath(connectorId), requestOptions(options));
  }

  /**
   * Register an inactive Connector. Registration is not retried; after an
   * OutcomeUnknownError, list the Connectors and match the display name, which
   * is unique in the Organization.
   */
  async register(input: RegisterConnectorInput): Promise<Connector> {
    requireKnownKeys(
      input,
      ["displayName", "transport", "endpointUrl", "signal", "requestId"],
      "Connector registration",
    );
    if (typeof input.displayName !== "string" || !input.displayName.trim())
      throw new TypeError("Connector registration requires a displayName");
    const { signal, requestId, ...body } = input;
    return connectorReceipt(
      await this.#http.postResponse<Connector>("/connectors", body, {
        outcomeUnknown: true,
        ...(signal ? { signal } : {}),
        ...(requestId ? { requestId } : {}),
      }),
    );
  }

  /** Edit an inactive Connector. */
  async update(
    connectorId: string,
    input: UpdateConnectorInput,
    options: ConnectorVersionOptions,
  ): Promise<Connector> {
    requireKnownKeys(input, ["displayName", "endpointUrl"], "Connector update");
    requireVersion(options, "Connector update");
    const { expectedConnectorVersion, ...request } = options;
    return connectorReceipt(
      await this.#http.patchResponse<Connector>(
        connectorPath(connectorId),
        { expectedConnectorVersion, ...input },
        { outcomeUnknown: true, ...request },
      ),
    );
  }

  /** Discover the endpoint's tools and activate the Connector. */
  activate(
    connectorId: string,
    options: ConnectorVersionOptions,
  ): Promise<Connector> {
    return this.#transition(connectorId, "activate", options);
  }

  /** Stop new calls to the Connector. */
  deactivate(
    connectorId: string,
    options: ConnectorVersionOptions,
  ): Promise<Connector> {
    return this.#transition(connectorId, "deactivate", options);
  }

  async #transition(
    connectorId: string,
    action: "activate" | "deactivate",
    options: ConnectorVersionOptions,
  ): Promise<Connector> {
    requireVersion(options, `Connector ${action}`);
    const { expectedConnectorVersion, ...request } = options;
    return connectorReceipt(
      await this.#http.postResponse<Connector>(
        `${connectorPath(connectorId)}/${action}`,
        { expectedConnectorVersion },
        // Not retried: a repeat after a lost response would be refused as a version conflict.
        { outcomeUnknown: true, ...request },
      ),
    );
  }
}
