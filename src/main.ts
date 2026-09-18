import { createServer } from "node:http";

import { config } from "./config";
import { logger } from "../shared/logger";
import { pollMessages, shutdown } from "./worker.js";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "iot-worker",
      })
    );

    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(config.PORT, () => {
  logger.info("health_server_started", {
    port: config.PORT,
  });
});

process.on("SIGTERM", () => {
  logger.info("sigterm_received");

  shutdown();

  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("sigint_received");

  shutdown();

  server.close(() => {
    process.exit(0);
  });
});

pollMessages().catch((error) => {
  logger.fatal("worker_crashed", {
    error: error instanceof Error ? error.message : String(error),
  });

  process.exit(1);
});