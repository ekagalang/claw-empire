/**
 * Default model choices per provider, shared by the frontend (DEFAULT_SETTINGS) and the server
 * (seeded providerModelConfig, see server/config/model-catalog.ts). Keep this file free of imports
 * so both the browser and the Node build can use it.
 *
 * Claude uses its tier aliases, which always resolve to the newest model of that tier.
 */
export const DEFAULT_PROVIDER_MODEL_CONFIG = {
  claude: { model: "opus", subModel: "sonnet" },
  codex: {
    model: "gpt-5.3-codex",
    reasoningLevel: "xhigh",
    subModel: "gpt-5.3-codex",
    subModelReasoningLevel: "high",
  },
  gemini: { model: "gemini-3-pro-preview" },
  opencode: { model: "github-copilot/claude-sonnet-4.6" },
  copilot: { model: "github-copilot/claude-sonnet-4.6" },
  antigravity: { model: "google/antigravity-gemini-3-pro" },
};
