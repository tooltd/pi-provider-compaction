# pi-provider-compaction

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that lets you compact (summarize) your context with a **separate, cheaper model** — with **per-model** `temperature` and `reasoning_effort` settings and quick-pick menus.

## How it works

When the session context grows, Pi compacts it into a summary. By default Pi uses the session's own model for that summary. This extension intercepts compaction and runs the summary with a model **you** pick — e.g. a fast, cheap model for summarizing while you code with a more expensive one.

Both `temperature` and `reasoning_effort` are stored **per model** (keyed by `provider/modelId`), because models differ in what they support. When a model has no setting, the parameter is **not sent** and the provider/model default applies.

### Default mode

You can also keep Pi's built-in compaction target (select **Default** in `/compact-model`) while still customizing it:

- **No settings** for the session model → Pi's built-in compaction runs untouched.
- **Temperature or reasoning effort set** for the session model → the extension runs the compaction itself, using the session model plus your settings.

So per-model settings work in both custom and default mode — in default mode they target the current session model.

## Requirements

- Pi coding agent (`@earendil-works/pi-coding-agent`)
- Models defined in `~/.pi/agent/models.json` — only configured providers appear in the model selector

## Installation

### Option 1: `pi install` (recommended)

```bash
pi install git:github.com/tooltd/pi-provider-compaction
```

Pi clones the repo and loads the extension through the `pi` manifest in `package.json`. To remove: `pi remove git:github.com/tooltd/pi-provider-compaction`.

### Option 2: manual

Drop this folder into Pi's extensions directory:

```
~/.pi/agent/extensions/pi-provider-compaction/
├── index.ts
├── package.json       # pi manifest + peer dependencies
└── config.json        # created on first use; see config.example.json
```

Pi loads extensions at startup. If you added the folder while Pi is already running, run `/reload`.

The extension is plain TypeScript loaded by Pi's transpiler — **no build step required**. The three `@earendil-works/*` packages are provided by Pi itself (declared as `peerDependencies` with `*`), so no installation is needed.

## Commands

| Command | Description |
|---------|-------------|
| `/compact-model` | Pick the compaction model (TUI selector like `/model`, with search). Option **Default** disables the custom model and restores Pi's built-in compaction. |
| `/compact-temp [value]` | Menu: **default / 0 / 0.3 / 0.7 / current / custom...** (`custom...` opens a manual 0.0–2.0 input). Pass a value directly to skip the menu: `/compact-temp 0.7`. Stored per model. |
| `/compact-reasoning [level]` | Menu: **default / low / medium / xhigh / current / custom...** (`custom...` opens a manual input for any level, e.g. `high`, `minimal`, `max`). Pass a level directly to skip the menu: `/compact-reasoning xhigh`. Stored per model. |
| `/compact-info` | Show the current compaction target, its temperature/reasoning effort, and all per-model settings. |

Menus highlight the currently active value; custom values not in the quick-pick list appear as their own `current: ...` entry so you can re-pick them in one press.

## Configuration

Settings persist in `config.json` next to `index.ts` and are loaded at session start.

```jsonc
{
  "provider": "openai-compatible",  // custom compaction model (null = Default mode)
  "modelId": "qwen3.6-27b",
  "temperatures": {                 // per-model; missing key = parameter not sent
    "openai-compatible/qwen3.6-27b": 0.7
  },
  "reasoningEfforts": {             // per-model; missing key = parameter not sent
    "openai-compatible/qwen3.6-27b": "xhigh"
  }
}
```

Notes:

- Keys are **opaque** `provider/modelId` strings — model IDs may themselves contain `/` (e.g. local GGUF paths), so keys are never split.
- A legacy global `"temperature"` value is auto-migrated into `temperatures` (under the custom model's key) on load.
- Copy `config.example.json` → `config.json` for a clean template.

### Reasoning effort & providers

`reasoningEffort` is passed through pi-ai's `complete()` options. pi-ai translates it into the provider-specific parameter (OpenAI/Qwen/DeepSeek/OpenRouter/Z.ai, …) and **safely ignores it** for models or compat layers that don't support it — so leaving `default` everywhere is always safe, and you only enable effort for models you know support it. For OpenAI-compatible models this lands in the request body, equivalent to `extra_body={"reasoning_effort": "low"}`.

### Reasoning-heavy models as the compaction model (Qwen 3.8 27B case)

Reasoning models spend a large share of their output budget on hidden reasoning tokens before writing the summary. A local **Qwen 3.8 27B** GGUF running at `xhigh` reasoned so long during compaction that the generation kept hitting its token cap before the summary was complete — even after raising `reserveTokens` to 24K — producing:

```
Summarization failed: generation hit the token cap and the summary is incomplete
```

Fix: set **`reasoningEffort` to `"low"` for that model**. Because the effort is stored per model, this only affects compaction — your main coding model keeps its own (higher) effort. `"medium"` is a reasonable middle ground if you want a bit more reasoning during compaction.

## Compaction flow

```
[Context exceeds threshold]
            ↓
[session_before_compact event]
            ↓
[Extension resolves the target:
 custom model, or the session model]
            ↓
   Is a custom model configured?
      │ yes                │ no
      ↓                    ↓
 complete() with      Does the session model have
 custom model         temp/reasoning set?
 (temp + effort)         │ no           │ yes
      │                  ↓              ↓
      │            Pi's built-in   complete() with
      │            compaction      session model
      │                              (temp + effort)
      ↓
[Summary returned → Pi compacts the context]
[On any failure → fall back to Pi's built-in compaction]
```

## Fallback behavior

The extension never blocks compaction. It returns nothing from the hook (→ Pi's built-in compaction runs) when:

- the selected model is not found in the model registry
- auth fails / no API key for the model's provider
- the summary response comes back empty
- the request throws (network error, timeout, abort)

## Typical setup

```
Session model:     qwen3.6-27b      (main coding model)
Compaction model:  gemini-2.5-flash (cheap & fast, summaries only)
Temperature:       0.7              (stored for the compaction model)
Reasoning effort:  xhigh            (stored for the compaction model)
```

## Model selection tips

| Model | Good for compaction? | Why |
|-------|----------------------|-----|
| gemini-2.5-flash | ✔ | Cheapest and fastest, great for summaries |
| claude-3.5-haiku | ✔ | Mid price, good quality |
| gpt-4o-mini | ✔ | Widely available, good enough |
| Local (llama.cpp) | ✔ | Free if you run it |
| claude-sonnet-4 | ✘ | Overkill — too expensive for summaries |

### Temperature guidance

- `0.0–0.5` — precise summaries, little creativity
- `0.7–1.0` — balanced
- `1.0–2.0` — creative, can hallucinate; rarely useful for compaction

## Gotchas

1. **`render()` must return `string[]`** in `ctx.ui.custom()` — returning a bare `string` renders one character per line.
2. **The model list comes from `models.json`**, not `modelRegistry.getAvailable()` — the registry filters out local providers.
3. **Model IDs can contain `/`** (local GGUF paths) — always treat `provider/modelId` keys as opaque strings.
4. **`default` means "do not send the parameter"** — it is not a value forwarded to the API.

## Development

- `tsconfig.check.json` — type-check config for local development; adjust the `paths` entries to point at your Pi install.
- Pi transpiles extensions **without type-checking**, so a few d.ts-level discrepancies in `index.ts` (e.g. `notify` with a `"success"` type, untyped TUI globals) are tolerated by the runtime.

## References

- [Pi Extensions Docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)
- [Pi Compaction Docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/compaction.md)
- [Custom Compaction Example](https://github.com/earendil-works/pi-coding-agent/blob/main/examples/extensions/custom-compaction.ts)
