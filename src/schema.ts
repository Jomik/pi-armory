import { type Static, Type } from "typebox";

const ArmoryToolSchema = Type.Object({
  name: Type.String(),
  command: Type.String(),
  description: Type.String(),
  requires_approval: Type.Optional(Type.Boolean()),
  guidelines: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Non-secret environment variables injected into the command. " +
        'Values starting with $ resolve from the host environment (e.g. "$SSH_AUTH_SOCK"). ' +
        "Use $$ to escape a literal dollar sign. These values are NOT redacted from output.",
    }),
  ),
  secrets: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Secret environment variables stored in the macOS Keychain. " +
        "Keys are env var names; values are keychain account names. " +
        "Resolved values are redacted from all tool output.",
    }),
  ),
  when: Type.Optional(
    Type.Union([Type.Literal("git"), Type.Literal("jj")], {
      description:
        "Restricts the tool to sessions whose workspace matches this repository type. " +
        '"jj" requires a Jujutsu repository; "git" requires a Git repository that is not also a Jujutsu repository. ' +
        "Omit to make the tool available in every workspace.",
    }),
  ),
});

export const ArmoryConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  draftModel: Type.Optional(Type.String()),
  disableBash: Type.Optional(Type.Boolean()),
  tools: Type.Array(ArmoryToolSchema),
});

export type ArmoryConfig = Static<typeof ArmoryConfigSchema>;
export type ArmoryTool = Static<typeof ArmoryToolSchema>;
