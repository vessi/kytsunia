import { matchDynamic } from "./rules/dynamic.js";
import { fixedRules } from "./rules/fixed.js";
import { matchForward } from "./rules/forwards.js";
import { matchLlmFallback } from "./rules/llm-fallback.js";
import { matchUrlRewrites } from "./rules/urls.js";
import type { Action, MessageInput, State } from "./types.js";

export function match(input: MessageInput, state: State): Action[] | null {
  const fwd = matchForward(input);
  if (fwd) return fwd;

  for (const rule of fixedRules) {
    const m = rule.pattern.exec(input.text);
    if (m) return rule.produce(input, m, state);
  }

  const url = matchUrlRewrites(input);
  if (url) return url;

  const dyn = matchDynamic(input, state);
  if (dyn) return dyn;

  const llm = matchLlmFallback(input, state);
  if (llm) return llm;

  return null;
}
