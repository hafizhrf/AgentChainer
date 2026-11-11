// Each agent harness's own mark (UX-23), to tell them apart at a glance: Claude and Codex from LobeHub Icons (MIT),
// Antigravity from Google's Antigravity press kit. The marks belong to their owners (see NOTICE); they only name the
// tools this app works with and don't suggest any endorsement.

import type { AgentId } from "./agentInfo.ts";
import antigravity from "./assets/agents/antigravity.svg";
import claude from "./assets/agents/claude.svg";
import codex from "./assets/agents/codex.svg";

export const AGENT_LOGOS: Record<AgentId, string> = { claude, codex, agy: antigravity };
