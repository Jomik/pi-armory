import { type Static, Type } from "typebox";

const ParameterSchema = Type.Object({
  type: Type.Union([Type.Literal("string"), Type.Literal("string[]")]),
  description: Type.Optional(Type.String()),
  optional: Type.Optional(Type.Boolean()),
});

const ArmoryToolSchema = Type.Object({
  name: Type.String(),
  command: Type.String(),
  description: Type.String(),
  requires_approval: Type.Optional(Type.Boolean()),
  guidelines: Type.Optional(Type.Array(Type.String())),
  parameters: Type.Optional(Type.Record(Type.String(), ParameterSchema)),
  secrets: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const ArmoryConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  draftModel: Type.Optional(Type.String()),
  disableBash: Type.Optional(Type.Boolean()),
  tools: Type.Array(ArmoryToolSchema),
});

export type ArmoryConfig = Static<typeof ArmoryConfigSchema>;
export type ArmoryTool = Static<typeof ArmoryToolSchema>;
