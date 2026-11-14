import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { OrganizationClient } from "@tidblink/server";

const replicaA = process.env.SDK_SERVICE_URL;
const replicaB = process.env.SDK_REPLICA_URL;
const apiKey = process.env.SDK_ORGANIZATION_KEY;
assert(replicaA && replicaB && apiKey, "Run this through npm run test:service");

const stage = (name) =>
  new Promise((resolve, reject) => {
    process.once("message", ({ error }) => (error ? reject(new Error(error)) : resolve()));
    process.send({ stage: name });
  });
const until = async (condition, what, timeoutMs = 60000) => {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await delay(50);
  }
};

/**
 * A TCP load balancer in front of both replicas: each new connection goes to
 * the first upstream that accepts it, so connections land on B while B runs
 * and on A once B has stopped, as behind a real load balancer.
 */
const loadBalancer = async (upstreams) => {
  const sockets = new Set();
  const server = net.createServer((downstream) => {
    downstream.pause();
    sockets.add(downstream);
    downstream.on("close", () => sockets.delete(downstream));
    downstream.on("error", () => undefined);
    const attempt = (index) => {
      if (index >= upstreams.length) return downstream.destroy();
      const { hostname, port } = new URL(upstreams[index]);
      const upstream = net.connect(Number(port), hostname);
      upstream.once("error", () => attempt(index + 1));
      upstream.once("connect", () => {
        upstream.removeAllListeners("error");
        upstream.on("error", () => downstream.destroy());
        sockets.add(upstream);
        upstream.on("close", () => {
          sockets.delete(upstream);
          downstream.destroy();
        });
        downstream.on("close", () => upstream.destroy());
        downstream.pipe(upstream);
        upstream.pipe(downstream);
        downstream.resume();
      });
    };
    attempt(0);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Cut every connection through the balancer, as a network failure would. */
    dropAll: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
};

const cursors = (events) => events.map((event) => event.cursor);
const released = (events, turnId) =>
  events.some((event) => event.type === "agent.session.idle" && event.data.turnId === turnId);

const balancer = await loadBalancer([replicaB, replicaA]);
const onA = new OrganizationClient({ baseUrl: replicaA, apiKey });
const behindBalancer = new OrganizationClient({ baseUrl: balancer.url, apiKey });
const elsewhere = new OrganizationClient({ baseUrl: replicaA, apiKey });
try {
  const { userId } = await onA.createEndUser({ externalId: `replicas-${randomUUID()}` });
  const session = await onA.user(userId).createSession({
    templateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });

  // The lamp's backend reaches the core through the balancer (replica B); an
  // observer on replica A follows the same Session.
  const runs = [];
  const lampEvents = [];
  const observed = [];
  const lamp = await behindBalancer.user(userId).session(session.id).connect({
    tools: {
      set_light: {
        description: "Set the lamp's brightness",
        parameters: {
          type: "object",
          properties: { brightness: { type: "integer" } },
          additionalProperties: false,
        },
        run: async (args) => {
          runs.push(args);
          return "Lamp dimmed to 40%";
        },
      },
    },
    onEvent: (event) => lampEvents.push(event),
  });
  let lampEnded;
  lamp.closed.then((end) => (lampEnded = end));
  await onA.user(userId).session(session.id).connect({
    observe: true,
    onEvent: (event) => observed.push(event),
  });

  // 1. A Turn on replica A calls the tool of the attachment on replica B.
  await stage("tool");
  const first = await onA
    .user(userId)
    .session(session.id)
    .turn({ clientEventId: randomUUID(), text: "Too bright" }, { timeoutMs: 30000, pollIntervalMs: 50 });
  assert.equal(first.text, "Dimmed.");
  assert.deepEqual(runs, [{ brightness: 40 }]);
  await until(
    () => released(lampEvents, first.turnId) && released(observed, first.turnId),
    "the first Turn's release on both replicas",
  );
  assert.deepEqual(cursors(lampEvents), cursors(observed));
  assert(lampEvents.some((event) => event.type === "agent.session.turn.requires_action"));

  // 2. Replica B drains and stops: the lamp's attachment moves to replica A.
  const before = lamp.generation;
  await stage("stopB");
  await until(() => lamp.generation > before, "the attachment to move to replica A");
  assert.equal(lampEnded, undefined, "a drain moves the connection, it does not end it");
  await stage("toolAgain");
  const second = await lamp.send("Still too bright", { timeoutMs: 30000 });
  assert.equal(second.text, "Dimmed again.");
  assert.equal(runs.length, 2);

  // 3. The network drops the lamp's connection while a Turn runs: send() still
  // gets its answer from the events replayed after the reconnect.
  await stage("held");
  const pending = lamp.send("One more", { timeoutMs: 60000 });
  await stage("awaitHeld");
  const moved = lamp.generation;
  balancer.dropAll();
  await stage("release");
  const third = await pending;
  assert.equal(third.text, "Held answer.");
  assert(lamp.generation > moved, "the lamp re-attached after the drop");
  await until(
    () => released(lampEvents, third.turnId) && released(observed, third.turnId),
    "the third Turn's release on both connections",
  );
  // Across the drain and the drop, the lamp received every event once, in order.
  assert.deepEqual(cursors(lampEvents), cursors(observed));
  assert.equal(new Set(cursors(lampEvents)).size, lampEvents.length);

  // 4. Another process attaches for execution: the lamp's connection is superseded.
  const taker = await elsewhere.user(userId).session(session.id).connect();
  assert.deepEqual(await lamp.closed, { reason: "superseded" });
  assert(taker.generation > lamp.generation);
  console.log(
    "Replicas consumer passed: cross-replica tool calls and events, drain to another replica, reconnect replay, supersession.",
  );
} finally {
  await Promise.all([onA.close(), behindBalancer.close(), elsewhere.close()]);
  balancer.close();
  process.disconnect();
}
