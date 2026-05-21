import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerArmoryTool } from "./register-tool.js";
import { registerRequestTool } from "./request-tool.js";

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = process.cwd();
  const { tools, draftModel } = await loadConfig(projectRoot);

  for (const tool of tools) {
    registerArmoryTool(pi, tool);
  }

  registerRequestTool(pi, projectRoot, draftModel);
};

export default factory;
