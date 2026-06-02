import type { BurmeseLexiconEntry, BurmeseNormalizationChange, BurmeseNormalizationResult } from "./types";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeBurmeseScript(script: string, entries: BurmeseLexiconEntry[], lexiconRevision: string): BurmeseNormalizationResult {
  const originalScript = script;
  const changes: BurmeseNormalizationChange[] = [];
  const canonicalDigits = script.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  if (canonicalDigits !== script) {
    changes.push({ source: "Full-width digits", spoken: "ASCII digits", reason: "Safe numeric canonicalization" });
  }
  let normalizedScript = canonicalDigits
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *([၊။]) */g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const orderedEntries = [...entries].sort((a, b) => b.source.length - a.source.length);
  for (const entry of orderedEntries) {
    const matcher = new RegExp(escapeRegExp(entry.source), "gu");
    if (!matcher.test(normalizedScript)) continue;
    normalizedScript = normalizedScript.replace(matcher, entry.spoken);
    changes.push({
      source: entry.source,
      spoken: entry.spoken,
      reason: entry.note || "Local pronunciation lexicon"
    });
  }

  return {
    originalScript,
    normalizedScript,
    changes,
    lexiconRevision
  };
}
