import { OrganizationClient } from "@tidblink/server";

/**
 * The backend of a smart lamp that users talk to by typing in an app or by
 * speaking to the lamp. Both share one Session, so one conversation history.
 *
 * - The lamp's functions are Client Tools: the model calls them, this backend
 *   runs them by forwarding to the lamp over your own device channel (MQTT,
 *   WebSocket, ...), and the core never talks to the lamp except for audio.
 * - While the lamp is online the backend keeps its Session connected, so the
 *   lamp's tools work for voice too. Typing while the lamp is offline still
 *   works; its tools then fail at once and the model says so.
 * - For voice the backend hands the lamp a short-lived grant; the lamp opens
 *   the Realtime WebSocket itself and audio never passes through here.
 *
 * `device` is your channel to the lamps:
 *   isOnline(deviceId) -> boolean
 *   request(deviceId, command, args, { signal }) -> Promise<result>, rejects on failure
 *   send(deviceId, topic, payload) -> void   (fire-and-forget, e.g. the voice grant)
 * `store` keeps who owns which lamp and where each Session's events were read;
 * the default keeps it in memory.
 */
export function createLampBackend({
  baseUrl,
  organizationApiKey,
  templateId,
  device,
  store = memoryStore(),
  onChat = () => {},
}) {
  const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
  /** deviceId -> SessionConnection while the lamp is online. */
  const online = new Map();

  // ── The lamp's functions (edge capabilities) ──────────────────────────────
  const lampTools = (deviceId) => {
    const ask = async (command, args, signal) => {
      // Fail at once instead of letting the model wait for a lamp that is not there.
      if (!device.isOnline(deviceId)) throw new Error("The lamp is offline");
      return device.request(deviceId, command, args, { signal });
    };
    return {
      set_light: {
        description: "Turn the lamp on or off, or set its brightness and colour temperature",
        parameters: {
          type: "object",
          properties: {
            on: { type: "boolean", description: "true turns the lamp on, false off" },
            brightness: { type: "integer", minimum: 1, maximum: 100, description: "Percent" },
            colorTemp: { type: "integer", minimum: 2700, maximum: 6500, description: "Kelvin" },
          },
          additionalProperties: false,
        },
        run: async (args, { signal }) => {
          const state = await ask("set_light", args, signal);
          return state.on
            ? `The lamp is on at ${state.brightness}% and ${state.colorTemp} K`
            : "The lamp is off";
        },
      },
      get_status: {
        description: "Read the lamp's state and the ambient light",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        run: async (_args, { signal }) => JSON.stringify(await ask("get_status", {}, signal)),
      },
      set_timer: {
        description: "Turn the lamp off after some minutes",
        parameters: {
          type: "object",
          properties: { minutes: { type: "integer", minimum: 1, maximum: 240 } },
          required: ["minutes"],
          additionalProperties: false,
        },
        run: async ({ minutes }, { signal }) => {
          await ask("set_timer", { minutes, action: "off" }, signal);
          return `The lamp turns off in ${minutes} minutes`;
        },
      },
    };
  };

  const sessionOf = async (deviceId) => {
    const binding = await store.binding(deviceId);
    if (!binding) throw new Error(`Lamp ${deviceId} is not bound to a user`);
    return organization.user(binding.userId).session(binding.sessionId);
  };

  const connect = async (deviceId) =>
    (await sessionOf(deviceId)).connect({
      tools: lampTools(deviceId),
      cursor: await store.cursor(deviceId),
      onCursor: (cursor) => store.saveCursor(deviceId, cursor),
      // What was said by voice also appears in the app.
      onTranscript: (t) => onChat(deviceId, { role: "user", text: t.text }),
      onResponse: (r) => onChat(deviceId, { role: "assistant", text: r.text }),
    });

  return {
    organization,

    /** The user binds a lamp in the app: one End User per app user, one Session per lamp. */
    async bindDevice(appUserId, deviceId) {
      const user = await organization.createEndUser({ externalId: appUserId }); // safe to repeat
      const session = await organization.user(user.userId).createSession({
        templateId,
        idempotencyKey: `lamp.${deviceId}`, // one Session per lamp, also after a retry
      });
      await store.bind(deviceId, { userId: user.userId, sessionId: session.id });
      return session.id;
    },

    /** The lamp came online: keep its Session connected while it stays online. */
    async onDeviceOnline(deviceId) {
      if (online.has(deviceId)) return;
      const conn = await connect(deviceId);
      online.set(deviceId, conn);
      // Another backend process took the lamp over, or the Session was deleted.
      conn.closed.then(() => {
        if (online.get(deviceId) === conn) online.delete(deviceId);
      });
    },

    /** The lamp went offline: release its Session. */
    async onDeviceOffline(deviceId) {
      const conn = online.get(deviceId);
      online.delete(deviceId);
      await conn?.close();
    },

    /**
     * The user typed in the app. Uses the lamp's connection when it is online,
     * otherwise a temporary one. `onDraft` receives the growing answer.
     */
    async onAppMessage(deviceId, text, { clientEventId, onDraft } = {}) {
      const existing = online.get(deviceId);
      const conn = existing ?? (await connect(deviceId));
      try {
        const reply = await conn.send(text, {
          ...(clientEventId ? { clientEventId } : {}),
          ...(onDraft ? { onProgress: onDraft } : {}),
        });
        return reply.text;
      } finally {
        if (!existing) await conn.close();
      }
    },

    /** The user pressed the talk button: give the lamp a short-lived grant to open voice. */
    async onDeviceWantsToTalk(deviceId) {
      const conn = online.get(deviceId);
      if (!conn) throw new Error(`Lamp ${deviceId} is not online`);
      const grant = await conn.realtimeGrant();
      device.send(deviceId, "voice_grant", grant);
      return grant;
    },

    /** Release every Session and close the Backend Connections, e.g. on shutdown. */
    async close() {
      online.clear();
      await organization.close();
    },
  };
}

/** In-memory bindings and cursors; use your database in production. */
export function memoryStore() {
  const bindings = new Map();
  const cursors = new Map();
  return {
    bind: async (deviceId, binding) => void bindings.set(deviceId, binding),
    binding: async (deviceId) => bindings.get(deviceId),
    cursor: async (deviceId) => cursors.get(deviceId),
    saveCursor: async (deviceId, cursor) => void cursors.set(deviceId, cursor),
  };
}
