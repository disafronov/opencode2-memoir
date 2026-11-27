/** Model reference passed to OpenCode when a capture session is created. */
export type CaptureModel = {
  id: string;
  providerID: string;
  variant?: string;
};

/**
 * Parse `MEMOIR_AGENT_MODEL` as `provider/model` or `provider/model:variant`.
 * Malformed values are rejected instead of guessing a provider or a bare model.
 */
export function parseCaptureModel(value: string | undefined): CaptureModel | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;

  const providerID = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (rest.includes("/")) return undefined;

  const colon = rest.indexOf(":");
  const id = colon === -1 ? rest : rest.slice(0, colon);
  const variant = colon === -1 ? undefined : rest.slice(colon + 1);
  if (!/^[^\s/]+$/.test(providerID)) return undefined;
  if (!/^[^\s/:]+$/.test(id)) return undefined;
  if (variant !== undefined && !/^[^\s/:]+$/.test(variant)) return undefined;

  return { id, providerID, ...(variant ? { variant } : {}) };
}

/**
 * Resolve the capture model from an explicit override, then from the model
 * active in the completed session. An absent result preserves OpenCode's
 * native default instead of inventing a config fallback.
 */
export function resolveCaptureModel(
  override: string | undefined,
  sessionModel: CaptureModel | undefined,
  warn: (message: string) => void = () => {},
): CaptureModel | undefined {
  if (override === undefined || override.trim() === "") return sessionModel;
  const parsed = parseCaptureModel(override);
  if (!parsed) {
    warn(`invalid MEMOIR_AGENT_MODEL "${override}"; expected provider/model[:variant]`);
    return sessionModel;
  }
  return parsed;
}
