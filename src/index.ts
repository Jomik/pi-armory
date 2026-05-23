import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerArmoryCommand } from "./manage-secrets.js";
import { registerArmoryTool } from "./register-tool.js";
import { registerRequestTool } from "./request-tool.js";

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = process.cwd();
  const { tools, draftModel, disableBash } = await loadConfig(projectRoot);

  if (disableBash) {
    pi.on("session_start", async (_event, _ctx) => {
      const active = pi.getActiveTools().filter((name) => name !== "bash");
      pi.setActiveTools(active);
    });
  }

  for (const tool of tools) {
    registerArmoryTool(pi, tool);
  }

  registerRequestTool(pi, projectRoot, draftModel);
  registerArmoryCommand(pi, tools);
};

export default factory;
