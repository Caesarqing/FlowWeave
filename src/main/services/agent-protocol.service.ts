export function buildAgentProtocolContextInstructions(): string[] {
  return [
    "## Agent Inbox Protocol v2",
    "",
    "- FlowWeave CLI and desktop agents use the same Agent Inbox file protocol.",
    "- The active request lives at `.flowweave/agent-inbox/current/request.json` and must be answered at that request's `responsePath`.",
    "- For artifact-analysis requests, `response.json.content` must contain the exact structured architecture or sequence JSON requested by `request.json.prompt`.",
    "- For implementation-plan requests, `response.json.content` may contain markdown plan text.",
    "- Do not edit `.flowweave/architecture-review.json` or `.flowweave/sequence-review.json`; FlowWeave Core validates and updates review state after response import.",
    ""
  ];
}
