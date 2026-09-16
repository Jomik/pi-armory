import { type Static, Type } from "typebox";

const EnvBindingSchema = Type.Union([
  Type.String({
    description: "A public literal value, used verbatim.",
  }),
  Type.Object(
    {
      env: Type.String({ minLength: 1, description: "Name of a host environment variable to read." }),
      secret: Type.Optional(
        Type.Boolean({ description: "Redact the resolved value from all tool output." }),
      ),
    },
    { additionalProperties: false, description: "Resolves from the host process environment." },
  ),
  Type.Object(
    {
      command: Type.String({ minLength: 1, description: "Shell command whose trimmed stdout becomes the value." }),
      secret: Type.Optional(
        Type.Boolean({ description: "Redact the resolved value from all tool output." }),
      ),
    },
    { additionalProperties: false, description: "Resolves by running a shell command." },
  ),
]);

const ArmoryToolSchema = Type.Object(
  {
    name: Type.String(),
    command: Type.String(),
    description: Type.String(),
    requires_approval: Type.Optional(Type.Boolean()),
    guidelines: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(
      Type.Record(Type.String(), EnvBindingSchema, {
        description:
          "Environment variables injected into the command. Each value is either a plain string " +
          "(a public literal, used verbatim), { env: string, secret?: boolean } to read a host " +
          "environment variable, or { command: string, secret?: boolean } to resolve the value by " +
          "running a shell command and using its trimmed stdout. Set secret:true to redact the " +
          "resolved value from all tool output.",
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
  },
  { additionalProperties: false },
);

export const ArmoryConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  draftModel: Type.Optional(Type.String()),
  disableBash: Type.Optional(Type.Boolean()),
  tools: Type.Array(ArmoryToolSchema),
});

export type ArmoryConfig = Static<typeof ArmoryConfigSchema>;
export type ArmoryTool = Static<typeof ArmoryToolSchema>;
export type EnvBinding = Static<typeof EnvBindingSchema>;
