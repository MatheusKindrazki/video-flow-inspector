#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  logger.info("Starting Video Flow Inspector MCP server");

  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info("Video Flow Inspector MCP server running on stdio");
}

main().catch((error) => {
  logger.error("Fatal error starting server", { error: String(error) });
  process.exit(1);
});
