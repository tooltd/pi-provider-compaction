/**
 * Pi Provider Compaction Extension
 *
 * Allows you to use a SEPARATE model (from Pi's available models) for compaction,
 * with configurable temperature. The compaction model is independent from your
 * main session model.
 *
 * Commands:
 *   /compact-model      - Select a model for compaction (like /model UI)
 *   /compact-temp       - Set temperature for compaction (0.0 - 2.0)
 *   /compact-reasoning  - Pick reasoning effort via menu (default | low | medium | xhigh | custom...); "custom" opens a manual input. Also accepts /compact-reasoning <value> directly.
 *   /compact-info       - Show current compaction model settings
 *
 * Temperature and reasoning effort are stored PER MODEL (keyed by
 * "provider/modelId"), because models differ in what they support. Unset means
 * "default": the parameter is not sent and the provider/model default applies.
 *
 * Default mode (no custom compaction model selected): settings still work. The
 * session model becomes the compaction target — when temperature or reasoning
 * effort is configured for it, the extension runs the compaction itself with the
 * session model instead of deferring to Pi's built-in compaction. With no
 * settings at all, Pi's built-in compaction runs untouched.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");

// --- Config File ---
const CONFIG_PATH = path.join(__dirname, "config.json");

/** Common levels offered as quick picks in the /compact-reasoning menu. */
const COMMON_REASONING_EFFORTS: string[] = ["low", "medium", "xhigh"];

/**
 * Reasoning effort settings, stored per compaction model.
 * Key: "provider/modelId" (opaque string, model IDs may themselves contain "/").
 * Value: any level string ("low", "medium", "xhigh", or custom like "high", "minimal", "max").
 * Missing key = default (parameter not sent).
 */
type ReasoningEffortMap = Record<string, string>;

interface CompactionConfig {
  provider: string | null;
  modelId: string | null;
  /** @deprecated Legacy global temperature — migrated to per-model `temperatures` on load. */
  temperature?: number | null;
  /** Per-model temperatures, keyed by "provider/modelId". Missing = provider default. */
  temperatures?: Record<string, number>;
  reasoningEfforts?: ReasoningEffortMap;
}

function loadConfig(): CompactionConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const cfg = { temperatures: {}, reasoningEfforts: {}, ...JSON.parse(raw) as CompactionConfig } as CompactionConfig;
      // Migrate legacy global temperature into the per-model map (attributed to the
      // custom compaction model when one is configured; dropped otherwise — it was
      // ignored in default mode before per-model temperature existed).
      if (typeof cfg.temperature === "number" && cfg.provider && cfg.modelId) {
        cfg.temperatures = { ...cfg.temperatures, [modelKey(cfg.provider, cfg.modelId)]: cfg.temperature };
      }
      delete cfg.temperature;
      return cfg;
    }
  } catch {
    // ignore
  }
  return { provider: null, modelId: null, temperatures: {}, reasoningEfforts: {} };
}

function saveConfig(config: CompactionConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // ignore write errors
  }
}

// --- State ---
let compactionProvider: string | null = null;
let compactionModelId: string | null = null;
let compactionTemperatures: Record<string, number> = {}; // per-model, missing = provider default
let compactionReasoningEfforts: ReasoningEffortMap = {}; // per-model, missing = default

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function temperatureFor(provider: string, modelId: string): number | null {
  return compactionTemperatures[modelKey(provider, modelId)] ?? null;
}

function effortFor(provider: string, modelId: string): string | null {
  return compactionReasoningEfforts[modelKey(provider, modelId)] ?? null;
}

interface CompactionTarget {
  provider: string;
  modelId: string;
  mode: "custom" | "default"; // "default" = session model (Pi built-in compaction target)
}

function resolveCompactionTarget(ctx: ExtensionContext): CompactionTarget | null {
  if (compactionProvider && compactionModelId) {
    return { provider: compactionProvider, modelId: compactionModelId, mode: "custom" };
  }
  if (ctx.model) {
    return { provider: ctx.model.provider, modelId: ctx.model.id, mode: "default" };
  }
  return null;
}

// --- Summary Prompt ---
const COMPACT_PROMPT = `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
[Files that were read]
</read-files>

<modified-files>
[Files that were modified]
</modified-files>

Previous context (if any):
{previousSummary}

Conversation to summarize:
<conversation>
{conversationText}
</conversation>`;

// --- Helper: Build compaction summary using custom model ---
async function compactWithModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  temperature: number | null,
  messagesToSummarize: unknown[],
  turnPrefixMessages: unknown[],
  previousSummary: string | undefined,
  tokensBefore: number,
  firstKeptEntryId: string,
  signal: AbortSignal | undefined,
): Promise<{ summary: string } | null> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    ctx.ui.notify(
      `Compaction model ${provider}/${modelId} not found, falling back to default`,
      "warning",
    );
    return null;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "error");
    return null;
  }
  if (!auth.apiKey) {
    ctx.ui.notify(
      `No API key for ${model.provider}, falling back to default compaction`,
      "warning",
    );
    return null;
  }

  const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
  const conversationText = serializeConversation(convertToLlm(allMessages));
  const previousContext = previousSummary ? previousSummary : "(No previous summary)";
  const prompt = COMPACT_PROMPT
    .replace("{previousSummary}", previousContext)
    .replace("{conversationText}", conversationText);

  const effort = effortFor(provider, modelId);
  const tempDisplay = temperature !== null ? ` temp=${temperature}` : "";
  const effortDisplay = effort !== null ? ` reasoning=${effort}` : "";
  ctx.ui.notify(`Compaction: ${model.id}${tempDisplay}${effortDisplay}`, "info");

  try {
    const options: Record<string, unknown> = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: 8192,
      signal,
    };

    if (temperature !== null) {
      options.temperature = temperature;
    }

    // Per-model reasoning effort. pi-ai translates this to the provider-specific
    // parameter (e.g. OpenAI-compatible "reasoning_effort" extra body) and safely
    // ignores it for models/compat that don't support it.
    if (effort !== null) {
      options.reasoningEffort = effort;
    }

    const response = await complete(
      model,
      { messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] },
      options,
    );

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!summary.trim()) {
      if (!signal?.aborted) {
        ctx.ui.notify("Compaction summary was empty, falling back to default", "warning");
      }
      return null;
    }

    ctx.ui.notify(`✓ Compaction done (${model.id})`, "success");
    return { summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Compaction failed: ${message}`, "error");
    return null;
  }
}

// --- Model entry (lightweight, from models.json) ---
interface ModelEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
}

interface ModelSelectorResult {
  provider: string | null; // null = Pi default compaction (no separate model)
  modelId: string | null;
}

function createModelSelector(
  tui: TUI,
  theme: Theme,
  _keybindings: KeybindingsManager,
  models: ModelEntry[],
  currentProvider: string | null,
  currentModelId: string | null,
  doneCb: (result: ModelSelectorResult | null) => void,
) {
  // Sort models: by provider then by id
  const sortedModels = [...models].sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.id.localeCompare(b.id);
  });

  // Build SelectItem list with context info in description
  const items: SelectItem[] = [{
    value: "__default__",
    label: "0. Default (Pi built-in compaction with session model)",
    description: "No separate model — disables custom compaction",
  }, ...sortedModels.map((m, i) => ({
    value: `${m.provider}:${m.id}`,
    label: `${i + 1}. ${m.id}`,
    description: `${m.contextWindow.toLocaleString()} ctx  ${m.provider}${m.reasoning ? " [reasoning]" : ""}${
      compactionReasoningEfforts[modelKey(m.provider, m.id)] ? `  reasoning=${compactionReasoningEfforts[modelKey(m.provider, m.id)]}` : ""
    }`,
  }))];

  const defaultIndex = 0;

  const container = new Container();

  // Top border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  // Title
  container.addChild(new Text(theme.fg("accent", theme.bold("Select Compaction Model")), 1, 0));

  // SelectList
  const selectList = new SelectList(items, Math.min(items.length, 14), {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });
  selectList.onSelect = (item: { value: string }) => {
    if (item.value === "__default__") {
      doneCb({ provider: null, modelId: null });
      return;
    }
    const [provider, modelId] = item.value.split(":");
    doneCb({ provider, modelId });
  };
  selectList.onCancel = () => doneCb(null);
  container.addChild(selectList);

  // Help text
  container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

  // Bottom border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  // Set initial selection
  if (currentProvider && currentModelId) {
    const idx = sortedModels.findIndex(
      (m) => m.provider === currentProvider && m.id === currentModelId,
    );
    selectList.selectedIndex = idx >= 0 ? idx + 1 : defaultIndex;
  } else {
    selectList.selectedIndex = defaultIndex;
  }

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      selectList.handleInput(data);
      tui.requestRender();
    },
  };
}

// --- Reasoning Effort Selector ---
interface ReasoningEffortSelectorResult {
  value: string; // "default", a level ("low"|"medium"|"xhigh"|custom), or "__custom__"
}

function createReasoningEffortSelector(
  tui: TUI,
  theme: Theme,
  _keybindings: KeybindingsManager,
  current: string | null,
  doneCb: (result: ReasoningEffortSelectorResult | null) => void,
) {
  const items: SelectItem[] = [
    {
      value: "default",
      label: "0. default — reasoning_effort not sent",
      description: "Provider/model default applies (safe for models without support)",
    },
    ...COMMON_REASONING_EFFORTS.map((e, i) => ({
      value: e,
      label: `${i + 1}. ${e}`,
      description:
        e === "low" ? "least reasoning — fastest & cheapest" : e === "medium" ? "balanced" : "most reasoning — slower, higher cost",
    })),
  ];

  // If the current level isn't in the common list, offer it as a quick re-pick.
  if (current && !COMMON_REASONING_EFFORTS.includes(current)) {
    items.push({
      value: current,
      label: `${items.length}. current: ${current}`,
      description: "keep the current custom level",
    });
  }

  items.push({
    value: "__custom__",
    label: `${items.length}. custom... — enter any level manually`,
    description: "e.g. high, minimal, max (sent as-is to the API)",
  });

  const defaultIndex = 0;

  const container = new Container();

  // Top border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  // Title
  container.addChild(new Text(theme.fg("accent", theme.bold("Select Reasoning Effort")), 1, 0));

  // SelectList
  const selectList = new SelectList(items, Math.min(items.length, 12), {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });
  selectList.onSelect = (item: { value: string }) => doneCb({ value: item.value });
  selectList.onCancel = () => doneCb(null);
  container.addChild(selectList);

  // Help text
  container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

  // Bottom border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  // Set initial selection
  if (current) {
    const idx = items.findIndex((i) => i.value === current);
    selectList.selectedIndex = idx >= 0 ? idx : defaultIndex;
  } else {
    selectList.selectedIndex = defaultIndex;
  }

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      selectList.handleInput(data);
      tui.requestRender();
    },
  };
}

// --- Temperature Selector ---
const TEMPERATURE_PRESETS: { value: number; description: string }[] = [
  { value: 0.0, description: "exact & deterministic — pure fact extraction" },
  { value: 0.3, description: "accurate summary, little creativity" },
  { value: 0.7, description: "balanced (common choice)" },
];

interface TemperatureSelectorResult {
  value: string; // "default" | preset number | current custom number | "__custom__"
}

function createTemperatureSelector(
  tui: TUI,
  theme: Theme,
  _keybindings: KeybindingsManager,
  current: number | null,
  doneCb: (result: TemperatureSelectorResult | null) => void,
) {
  const items: SelectItem[] = [
    {
      value: "default",
      label: "0. default — temperature not sent",
      description: "Provider default applies (safe for any model)",
    },
    ...TEMPERATURE_PRESETS.map((p, i) => ({
      value: String(p.value),
      label: `${i + 1}. ${p.value}`,
      description: p.description,
    })),
  ];

  // If the current value isn't a preset, offer it as a quick re-pick.
  if (current !== null && !TEMPERATURE_PRESETS.some((p) => p.value === current)) {
    items.push({
      value: String(current),
      label: `${items.length}. current: ${current}`,
      description: "keep the current custom value",
    });
  }

  items.push({
    value: "__custom__",
    label: `${items.length}. custom... — enter any value 0.0 - 2.0`,
    description: "e.g. 0.1, 0.5, 1.2 (sent as-is to the API)",
  });

  const defaultIndex = 0;

  const container = new Container();

  // Top border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  // Title
  container.addChild(new Text(theme.fg("accent", theme.bold("Select Compaction Temperature")), 1, 0));

  // SelectList
  const selectList = new SelectList(items, Math.min(items.length, 12), {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });
  selectList.onSelect = (item: { value: string }) => doneCb({ value: item.value });
  selectList.onCancel = () => doneCb(null);
  container.addChild(selectList);

  // Help text
  container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

  // Bottom border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  // Set initial selection
  if (current !== null) {
    const idx = items.findIndex((i) => i.value === String(current));
    selectList.selectedIndex = idx >= 0 ? idx : defaultIndex;
  } else {
    selectList.selectedIndex = defaultIndex;
  }

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      selectList.handleInput(data);
      tui.requestRender();
    },
  };
}

// --- Extension Entry ---
export default function (pi: ExtensionAPI) {
  // --- Compaction Hook ---
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, previousSummary, tokensBefore, firstKeptEntryId } = preparation;

    const target = resolveCompactionTarget(ctx);
    if (!target) {
      return;
    }

    // Default mode (no custom model): only take over Pi's built-in compaction
    // when there is something to customize for the session model.
    const temp = temperatureFor(target.provider, target.modelId);
    if (target.mode === "default" && temp === null && effortFor(target.provider, target.modelId) === null) {
      return;
    }

    const result = await compactWithModel(
      ctx,
      target.provider,
      target.modelId,
      temp,
      messagesToSummarize,
      turnPrefixMessages,
      previousSummary,
      tokensBefore,
      firstKeptEntryId,
      signal,
    );

    if (!result) {
      return;
    }

    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId,
        tokensBefore,
      },
    };
  });

  // --- Command: /compact-model ---
  pi.registerCommand("compact-model", {
    description: "Select a model for compaction (like /model)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("compact-model requires interactive TUI mode", "error");
        return;
      }

      // Build model list directly from models.json (only configured providers)
      const models = loadModelsFromJson();

      if (models.length === 0) {
        ctx.ui.notify("No models found in models.json", "error");
        return;
      }

      const result = await ctx.ui.custom<ModelSelectorResult | null>(
        (tui, theme, keybindings, doneCb) => {
          return createModelSelector(
            tui,
            theme,
            keybindings,
            models,
            compactionProvider,
            compactionModelId,
            doneCb,
          );
        },
      );

      if (!result) {
        ctx.ui.notify("Compaction model selection cancelled", "info");
        return;
      }

      compactionProvider = result.provider;
      compactionModelId = result.modelId;
      persistConfig();

      if (!compactionProvider) {
        const session = ctx.model;
        const temp = session ? temperatureFor(session.provider, session.id) : null;
        const effort = session ? effortFor(session.provider, session.id) : null;
        const extras = [
          temp !== null ? `temp=${temp}` : "",
          effort !== null ? `reasoning=${effort}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        ctx.ui.notify(
          extras
            ? `Compaction: default mode — will run with session model${session ? ` (${session.id})` : ""} using ${extras} instead of Pi's built-in`
            : "Compaction: using Pi's default (session model) — custom compaction disabled",
          "success",
        );
        return;
      }

      const temp = temperatureFor(compactionProvider, compactionModelId);
      const tempInfo = temp !== null ? ` (temp: ${temp})` : "";
      const effort = effortFor(compactionProvider, compactionModelId);
      const effortInfo = effort !== null ? ` (reasoning: ${effort})` : "";
      ctx.ui.notify(
        `Compaction model set to ${compactionProvider}/${compactionModelId}${tempInfo}${effortInfo}`,
        "success",
      );
    },
  });

  // --- Command: /compact-temp ---
  pi.registerCommand("compact-temp", {
    description:
      "Set compaction temperature for the current target (menu: default|0|0.3|0.7|custom...) — or pass a value directly (0.0-2.0). Stored per model.",
    handler: async (args, ctx) => {
      const target = resolveCompactionTarget(ctx);
      if (!target) {
        ctx.ui.notify("No compaction target available (no session model).", "error");
        return;
      }

      const targetLabel =
        target.mode === "default"
          ? `${target.provider}/${target.modelId} (session model — default compaction)`
          : `${target.provider}/${target.modelId}`;
      const targetKey = modelKey(target.provider, target.modelId);

      const apply = (raw: string): boolean => {
        const trimmed = raw.trim();
        const lower = trimmed.toLowerCase();
        if (lower === "" || lower === "default" || lower === "null" || lower === "reset") {
          delete compactionTemperatures[targetKey];
          persistConfig();
          ctx.ui.notify(`Temperature for ${targetLabel} reset to provider default`, "info");
          return true;
        }
        const parsed = parseFloat(trimmed);
        if (isNaN(parsed) || parsed < 0 || parsed > 2) {
          ctx.ui.notify(`Invalid temperature '${trimmed}'. Must be between 0.0 and 2.0 (or 'default').`, "error");
          return false;
        }
        compactionTemperatures[targetKey] = parsed;
        persistConfig();
        ctx.ui.notify(`Temperature for ${targetLabel} set to ${parsed}`, "success");
        return true;
      };

      // Fast path: value passed directly, e.g. /compact-temp 0.7
      const raw = (args || "").trim();
      if (raw && apply(raw)) {
        return;
      }

      if (ctx.mode !== "tui") {
        if (!raw) {
          const current = temperatureFor(target.provider, target.modelId);
          const input = await ctx.ui.input(
            "Set Compaction Temperature",
            `Temperature for ${targetLabel} (0.0 - 2.0, or 'default' to reset) — current: ${current ?? "default"}`,
          );
          if (input === undefined) return; // cancelled
          apply(input);
          return;
        }
        ctx.ui.notify("Usage: /compact-temp <0.0-2.0|default> (menu requires TUI mode)", "error");
        return;
      }

      // Menu: quick picks + custom input
      const current = temperatureFor(target.provider, target.modelId);
      const result = await ctx.ui.custom<TemperatureSelectorResult | null>(
        (tui, theme, keybindings, doneCb) =>
          createTemperatureSelector(tui, theme, keybindings, current, doneCb),
      );

      if (!result) {
        ctx.ui.notify("Temperature selection cancelled", "info");
        return;
      }

      if (result.value === "__custom__") {
        const input = await ctx.ui.input(
          "Custom Temperature",
          `Enter temperature for ${targetLabel} (0.0 - 2.0):`,
        );
        if (input === undefined) return; // cancelled
        apply(input);
        return;
      }

      apply(result.value);
    },
  });

  // --- Command: /compact-reasoning ---
  pi.registerCommand("compact-reasoning", {
    description:
      "Pick reasoning effort for the compaction target (menu: default|low|medium|xhigh|custom...) — or pass a value directly",
    handler: async (args, ctx) => {
      const target = resolveCompactionTarget(ctx);
      if (!target) {
        ctx.ui.notify("No compaction target available (no session model).", "error");
        return;
      }

      const targetLabel =
        target.mode === "default"
          ? `${target.provider}/${target.modelId} (session model — default compaction)`
          : `${target.provider}/${target.modelId}`;
      const targetKey = modelKey(target.provider, target.modelId);

      const apply = (raw: string): boolean => {
        const value = raw.trim().toLowerCase();
        if (value === "" || value === "default" || value === "null" || value === "reset") {
          delete compactionReasoningEfforts[targetKey];
          persistConfig();
          ctx.ui.notify(`Reasoning effort for ${targetLabel} reset to default (param not sent)`, "info");
          return true;
        }
        if (!/^[a-z0-9_-]+$/.test(value)) {
          ctx.ui.notify(
            `Invalid reasoning effort '${raw.trim()}'. Use letters, digits, - or _ (or 'default').`,
            "error",
          );
          return false;
        }
        compactionReasoningEfforts[targetKey] = value;
        persistConfig();
        ctx.ui.notify(`Reasoning effort for ${targetLabel} set to ${value}`, "success");
        return true;
      };

      // Fast path: value passed directly, e.g. /compact-reasoning xhigh
      const raw = (args || "").trim();
      if (raw && apply(raw)) {
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "Usage: /compact-reasoning <low|medium|xhigh|custom-value|default> (menu requires TUI mode)",
          "error",
        );
        return;
      }

      // Menu: quick picks + custom input
      const current = effortFor(target.provider, target.modelId);
      const result = await ctx.ui.custom<ReasoningEffortSelectorResult | null>(
        (tui, theme, keybindings, doneCb) =>
          createReasoningEffortSelector(tui, theme, keybindings, current, doneCb),
      );

      if (!result) {
        ctx.ui.notify("Reasoning effort selection cancelled", "info");
        return;
      }

      if (result.value === "__custom__") {
        const input = await ctx.ui.input(
          "Custom Reasoning Effort",
          `Enter reasoning effort level for ${targetLabel} (e.g. high, minimal, max — sent as-is to the API):`,
        );
        if (input === undefined) return; // cancelled
        apply(input);
        return;
      }

      apply(result.value);
    },
  });

  // --- Command: /compact-info ---
  pi.registerCommand("compact-info", {
    description: "Show current compaction model settings",
    handler: async (_args, ctx) => {
      let info = "=== Compaction Model Settings ===\n\n";

      const target = resolveCompactionTarget(ctx);

      if (target && target.mode === "custom") {
        const model = ctx.modelRegistry.find(target.provider, target.modelId);
        info += `Model: ${target.provider}/${target.modelId}\n`;
        if (model) {
          info += `  Display: ${model.name || model.id}\n`;
          info += `  Context: ${(model.contextWindow / 1000).toFixed(0)}k tokens\n`;
          info += `  Max output: ${(model.maxTokens / 1000).toFixed(1)}k tokens\n`;
          info += `  Reasoning: ${model.reasoning ? "Yes" : "No"}\n`;
        }
      } else if (target) {
        info += `Model: default (session model: ${target.provider}/${target.modelId})\n`;
        const model = ctx.modelRegistry.find(target.provider, target.modelId);
        if (model) {
          info += `  Display: ${model.name || model.id}\n`;
          info += `  Context: ${(model.contextWindow / 1000).toFixed(0)}k tokens\n`;
          info += `  Max output: ${(model.maxTokens / 1000).toFixed(1)}k tokens\n`;
          info += `  Reasoning: ${model.reasoning ? "Yes" : "No"}\n`;
        }
        const temp = temperatureFor(target.provider, target.modelId);
        const effort = effortFor(target.provider, target.modelId);
        if (temp !== null || effort !== null) {
          info += `  Note: compaction runs with session model + settings (not Pi's built-in)\n`;
        }
      } else {
        info += "Model: Not set (using Pi's default compaction)\n";
      }

      if (target) {
        const temp = temperatureFor(target.provider, target.modelId);
        const effort = effortFor(target.provider, target.modelId);
        const label =
          target.mode === "default"
            ? `session model ${target.provider}/${target.modelId}`
            : `${target.provider}/${target.modelId}`;
        info += `\nTemperature (${label}): ${temp !== null ? temp : "default (provider default)"}\n`;
        info += `Reasoning effort (${label}): ${effort ?? "default (param not sent)"}\n`;
      } else {
        info += `\nTemperature: not applicable\n`;
        info += `Reasoning effort: not applicable\n`;
      }

      const allKeys = [
        ...new Set([...Object.keys(compactionTemperatures), ...Object.keys(compactionReasoningEfforts)]),
      ];
      const targetKey = target ? modelKey(target.provider, target.modelId) : null;
      const otherKeys = targetKey ? allKeys.filter((k) => k !== targetKey) : allKeys;
      if (otherKeys.length > 0) {
        info += `\nOther configured models:\n`;
        for (const key of otherKeys) {
          const t = compactionTemperatures[key];
          const e = compactionReasoningEfforts[key];
          info += `  - ${key}: temp=${t !== undefined ? t : "default"}, reasoning=${e ?? "default"}\n`;
        }
      }

      info += `\nSession model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}\n`;
      info += `\nNote: Compaction model is independent from session model.\n`;
      info += `Reasoning effort is per-model; models that don't support it should stay 'default'.\n`;

      ctx.ui.notify(info.trim(), "info");
    },
  });

  // --- Load config on session start ---
  pi.on("session_start", async (_event, _ctx) => {
    const config = loadConfig();
    compactionProvider = config.provider;
    compactionModelId = config.modelId;
    compactionTemperatures = config.temperatures ?? {};
    compactionReasoningEfforts = config.reasoningEfforts ?? {};
  });

  // --- Persist config helper ---
  function persistConfig(): void {
    saveConfig({
      provider: compactionProvider,
      modelId: compactionModelId,
      temperatures: compactionTemperatures,
      reasoningEfforts: compactionReasoningEfforts,
    });
  }

  // --- Helper: Load models from models.json ---
  function loadModelsFromJson(): ModelEntry[] {
    try {
      if (fs.existsSync(MODELS_JSON_PATH)) {
        const raw = fs.readFileSync(MODELS_JSON_PATH, "utf-8");
        const data = JSON.parse(raw) as { providers?: Record<string, any> };
        if (data.providers) {
          const entries: ModelEntry[] = [];
          for (const [providerName, config] of Object.entries(data.providers)) {
            if (!config || !Array.isArray(config.models)) continue;
            for (const m of config.models) {
              entries.push({
                provider: providerName,
                id: m.id || "unknown",
                name: m.name || m.id || "unknown",
                contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 128000,
                reasoning: m.reasoning === true,
              });
            }
          }
          return entries;
        }
      }
    } catch {
      // ignore
    }
    return [];
  }
}
