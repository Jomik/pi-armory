import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import { SecretsPanel } from "./secrets-panel.js";

export function registerArmoryCommand(pi: ExtensionAPI, tools: ArmoryTool[]): void {
  pi.registerCommand("armory", {
    description: "Manage armory secrets: /armory secrets",
    getArgumentCompletions(prefix) {
      const items = [{ value: "secrets", label: "secrets", description: "Manage keychain secrets" }];
      if (!prefix) return items;
      const lower = prefix.toLowerCase();
      const filtered = items.filter((i) => i.value.startsWith(lower));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(args, ctx) {
      const sub = args.trim().toLowerCase();
      if (sub === "secrets") {
        await handleSecrets(ctx, tools);
      } else {
        ctx.ui.notify(`Unknown: ${sub}. Available: secrets`, "error");
      }
    },
  });
}

type Ctx = Pick<ExtensionCommandContext, "ui">;

function getAccounts(tools: ArmoryTool[]): string[] {
  const accounts = new Set<string>();
  for (const tool of tools) {
    if (tool.secrets) {
      for (const account of Object.values(tool.secrets)) {
        accounts.add(account);
      }
    }
  }
  return [...accounts].sort();
}

async function handleSecrets(ctx: Ctx, tools: ArmoryTool[]): Promise<void> {
  const accounts = getAccounts(tools);
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) =>
      new SecretsPanel({
        tui,
        theme,
        done,
        notify: (msg, type) => ctx.ui.notify(msg, type),
        accounts,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: 50, maxHeight: "60%" } },
  );
}
