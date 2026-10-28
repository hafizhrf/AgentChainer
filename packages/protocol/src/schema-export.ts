import { z } from "zod";
import { methodSchemas, notificationSchemas, PROTOCOL_VERSION } from "./index.ts";

/** The protocol as one JSON Schema document (M1-02), for docs and any future non-TS client. */
export function protocolJsonSchema() {
  const methods = Object.fromEntries(
    Object.entries(methodSchemas).map(([name, { params, result }]) => [
      name,
      { params: z.toJSONSchema(params), result: z.toJSONSchema(result) },
    ]),
  );
  const notifications = Object.fromEntries(
    Object.entries(notificationSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  );
  return {
    $comment: "Generated from packages/protocol/src/index.ts by `pnpm --filter @agentchainer/protocol export-schema`.",
    protocolVersion: PROTOCOL_VERSION,
    methods,
    notifications,
  };
}

export const schemaFileText = () => `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`;
