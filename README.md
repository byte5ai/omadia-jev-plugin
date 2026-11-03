# @omadia/decision-jev

[TypeSafe AI's Jev](https://typesafe.ai) as the omadia **decision model** (`decisionModel@1`).

Jev is a "System One" model: it does not write text. It returns a typed decision with a calibrated confidence, and it evaluates every question of a request in parallel. Installed in omadia, it decides every chat message **before any language-model call**, in a single request:

1. **Gate.** Does the message need a language model? If yes, it goes straight to the agent with a simple/complex hint, and the fast path makes no model call at all.
2. **Source.** If no, which data source answers it? That can be any read tool the agent offers: a plugin tool, an API-backed tool, or an MCP tool its server marks read-only.
3. **Direct plan.** Does a learned query fit, and which part of the message fills its placeholders (a customer name, an e-mail)? If so, it runs without any model call. This only happens while a Privacy Shield runs, and only for messages without numbers.
4. **Plan needed?** The plan-runner takes Jev's answer instead of asking a model of its own.

Jev also decides which recalled notes are relevant, whether a turn is worth remembering, and, in the answer verifier, whether the evidence supports a claim. In every case the language model takes over when Jev is unsure or fails.

If Jev fails, times out or is unsure, the fast path falls back to its usual model check, so the plugin can only save model calls, never lose answers. In the web chat, a badge on each answer shows what Jev decided.

Requires omadia with `@omadia/plugin-api` >= 1.53.0 and `@omadia/fast-path` >= 0.3.0 for the one-request gate (older hosts use the single decisions).

## Setup

| Field | Default | |
|---|---|---|
| `jev_api_key` | — | TypeSafe API key (vault). Without it the plugin decides nothing. |
| `jev_base_url` | `https://api.typesafe.ai` | Or a gateway (OpenRouter, LiteLLM, Zuplo), with or without `/v1`. |
| `jev_model` | `jev-1.14.0` | Pinned on purpose. The fast path's thresholds are tuned per version. A gateway prefix (`jev/`) is dropped for api.typesafe.ai. |
| `jev_timeout_ms` | `1500` | Keep it below the fast path's 2 s deadline. |
| `jev_tasks` | `all` | `fast-path.turn-gate` (the whole fast-path gate in one request), `recall.relevance`, `memory.significance`, `verifier.evidence-judge`, `canvas.layout` (table or bar/line/pie chart for planned rows on the canvas), or the older single decisions `fast-path.gate` / `fast-path.source` / `fast-path.direct-plan`. |

In the fast path's settings, `fast_path_decision_model`, `fast_path_decision_direct_plans` and `fast_path_decision_canvas` (the canvas view and layout) switch the use on and off.

## Privacy

Jev receives the chat message **after** the Privacy Shield has masked it (when one runs), plus fixed option texts: tool descriptions and stored, literal-stripped example questions. It never sees tool results or rows, and it never runs a tool. Logs contain the task, the choice, the confidence, the time and the cost, never the message.

## Guardrails

- Per-call timeout.
- Circuit breaker: after 3 consecutive failures the plugin pauses for 30 s. On a 429 it pauses for the `retry-after` time. On a 401/403 it pauses for 5 min.
- Every answer is validated against the requested options.

## Development

```bash
npm install
npm run typecheck && npm test
npm run build && npm run package   # → out/omadia-decision-jev-<version>.zip
```

The version lives in `package.json` **and** `manifest.yaml`, and the Hub reads the manifest. `npm run package` refuses to build when the two differ.

## License

MIT © byte5 GmbH
