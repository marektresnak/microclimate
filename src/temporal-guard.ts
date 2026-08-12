/**
 * Refuses to start on a runtime without Temporal, before any module that
 * builds a Duration at load time gets evaluated — which is why this import
 * sits first in `main.ts`.
 *
 * The check exists because "Node >= 26" is not the whole truth: official
 * nodejs.org builds ship Temporal, but Homebrew compiles its node without it
 * (it conflicts with their shared ICU library), so an engines check alone
 * would wave through a runtime that dies on the first instant it touches —
 * with a bare ReferenceError instead of a sentence naming the fix.
 */
if (typeof Temporal === 'undefined') {
  console.error(
    'This runtime has no Temporal, which microclimate is built on.\n' +
      'Node 26+ from nodejs.org ships it (nvm and fnm install those builds); ' +
      "Homebrew's node deliberately excludes it. Run with an official build.",
  );
  process.exit(1);
}

export {};
