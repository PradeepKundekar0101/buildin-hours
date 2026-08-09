import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { api } from "./api/routes.js";
import { skills } from "./skills/registry.js";
import { attachMediaStream } from "./transports/twilio.js";
import { env, bootReport } from "./env.js";
import { log } from "./log.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded
app.use(api);

const server = createServer(app);

/**
 * Twilio opens one media-stream socket per call at /media/:callId. We hand it to
 * the transport that is already waiting on that id.
 */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const path = req.url ?? "";
  const match = path.match(/^\/media\/([\w-]+)/);
  if (!match) {
    socket.destroy();
    return;
  }
  const callId = match[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!attachMediaStream(callId, ws)) {
      log.warn(`media stream for unknown call ${callId}, closing`);
      ws.close();
      return;
    }
    log.info(`media stream attached for ${callId.slice(0, 8)}`);
  });
});

const { errors } = skills.load();

server.listen(env.port, () => {
  log.info(`MolBhav orchestrator on :${env.port}`);
  for (const line of bootReport()) log.info(`  ${line}`);
  if (errors.length) {
    log.warn(`${errors.length} skill file(s) rejected - run 'pnpm skills:check' for detail`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
