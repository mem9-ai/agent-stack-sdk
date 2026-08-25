import { HttpClient } from "./http.js";

export interface WorkspaceClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface UserApiKey {
  apiKeyId: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  createdByUserId: string | null;
  createdByWorkspaceApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export class ServiceUser {
  readonly #http: HttpClient;
  readonly id: string;

  constructor(http: HttpClient, id: string) {
    if (!id) throw new TypeError("Service User id is required");
    this.#http = http;
    this.id = id;
  }

  async listApiKeys(options?: { signal?: AbortSignal }): Promise<UserApiKey[]> {
    const response = await this.#http.get<{ apiKeys: UserApiKey[] }>(
      `/api/admin/users/${encodeURIComponent(this.id)}/api-keys`,
      options,
    );
    return response.apiKeys;
  }
}

export class WorkspaceClient {
  readonly #http: HttpClient;

  constructor(options: WorkspaceClientOptions) {
    if (!options.apiKey.startsWith("ag9_wak.")) {
      throw new TypeError("WorkspaceClient requires a Workspace API Key");
    }
    this.#http = new HttpClient(options);
  }

  serviceUser(id: string): ServiceUser {
    return new ServiceUser(this.#http, id);
  }
}
