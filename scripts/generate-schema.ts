import fs from "node:fs";
import path from "node:path";
import { ArmoryConfigSchema } from "../src/schema.ts";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://raw.githubusercontent.com/Jomik/pi-armory/main/armory.schema.json",
  title: "Armory Config",
  ...ArmoryConfigSchema,
};

const outPath = path.join(import.meta.dirname, "..", "armory.schema.json");
fs.writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Written: ${outPath}`);
