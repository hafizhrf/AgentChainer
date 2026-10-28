import { PROTOCOL_VERSION } from "@agentchainer/protocol";

// stdout is reserved for protocol frames (ADR-0003); logs go to stderr.
// The JSON-RPC loop and the Agent SDK runtime arrive with spikes S1/S2 and M1-01.
process.stderr.write(`agentchainer-sidecar: scaffold only (protocol v${PROTOCOL_VERSION})\n`);
