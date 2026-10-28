/**
 * Version of the JSON-RPC protocol between the Rust core and the sidecar.
 * Exchanged in the `system.hello` handshake; see docs/ARCHITECTURE.md §4.
 * Schemas (zod) arrive with checklist item M1-02.
 */
export const PROTOCOL_VERSION = 1;
