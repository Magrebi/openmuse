import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { attachMirror } from "./mirror-routes.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, auth, agent, browser, undo } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
// A WebSocket upgrade never reaches Hono's fetch handler, so the mirror has to
// attach to the underlying Node server rather than to the app.
const mirror = attachMirror(server as unknown as Parameters<typeof attachMirror>[0], {
  browser,
  auth,
});
// The queue is closed without `commitPending`, so a shutdown never begins a new
// external write on its way out: anything still inside its undo window is simply
// never taken. Its timers are already unref'd, so this is about the actions
// rather than about letting the process exit.
const shutdown = () => {
  server.close(() => {
    void undo
      .close()
      .then(() => agent.stop())
      .then(() => mirror.close())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
