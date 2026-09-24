// Renders the README diagrams as SVG, in the console's look: zinc cards, rounded corners,
// Lucide icons, one accent color per service. Writes a dark and a light variant of each.
// Run: bun run docs:diagrams

const ICONS = new URL(
  "../../apps/console/node_modules/lucide-react/dist/esm/icons/",
  import.meta.url,
);

type IconNode = [tag: string, attributes: Record<string, string>][];

const iconCache = new Map<string, IconNode>();
async function icon(name: string): Promise<IconNode> {
  const cached = iconCache.get(name);
  if (cached) return cached;
  const source = await Bun.file(new URL(`${name}.mjs`, ICONS)).text();
  // The icon data is not exported; take the `node: [...]` literal by matching brackets.
  const start = source.indexOf("node: [");
  if (start < 0) throw new Error(`Lucide icon ${name}: no node data`);
  let depth = 0;
  let end = start + "node: ".length;
  for (; end < source.length; end++) {
    if (source[end] === "[") depth++;
    if (source[end] === "]" && --depth === 0) break;
  }
  const literal = source.slice(start + "node: ".length, end + 1);
  const node = new Function(`return ${literal}`)() as IconNode;
  iconCache.set(name, node);
  return node;
}

interface Theme {
  readonly name: "dark" | "light";
  readonly panel: string;
  readonly panelBorder: string;
  readonly card: string;
  readonly border: string;
  readonly group: string;
  readonly groupBorder: string;
  readonly text: string;
  readonly muted: string;
  readonly edge: string;
  readonly pill: string;
  readonly pillText: string;
  readonly neutralIconBg: string;
  readonly neutralIcon: string;
}

const THEMES: Theme[] = [
  {
    name: "dark",
    panel: "#09090b",
    panelBorder: "#27272a",
    card: "#18181b",
    border: "#27272a",
    group: "#18181b66",
    groupBorder: "#3f3f46",
    text: "#fafafa",
    muted: "#a1a1aa",
    edge: "#71717a",
    pill: "#27272a",
    pillText: "#e4e4e7",
    neutralIconBg: "#27272a",
    neutralIcon: "#e4e4e7",
  },
  {
    name: "light",
    panel: "#ffffff",
    panelBorder: "#e4e4e7",
    card: "#ffffff",
    border: "#e4e4e7",
    group: "#f4f4f599",
    groupBorder: "#d4d4d8",
    text: "#09090b",
    muted: "#71717a",
    edge: "#a1a1aa",
    pill: "#f4f4f5",
    pillText: "#3f3f46",
    neutralIconBg: "#f4f4f5",
    neutralIcon: "#18181b",
  },
];

/** One hue per part, matching the console's service colors. */
const ACCENT = {
  voice: "#6366f1",
  lookup: "#3b82f6",
  sync: "#f97316",
  api: "#a855f7",
  store: "#10b981",
  telemetry: "#f59e0b",
  console: "#0ea5e9",
} as const;

const FONT = `Geist, Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Card {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h?: number;
  readonly title: string;
  readonly lines?: ReadonlyArray<string>;
  readonly icon: string;
  readonly accent?: string;
}

interface Group {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
  readonly accent?: string;
}

interface Edge {
  /** SVG path data. */
  readonly d: string;
  readonly label?: string;
  /** Where the label pill sits. */
  readonly at?: readonly [number, number];
  readonly both?: boolean;
  readonly dashed?: boolean;
}

interface Diagram {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly groups: ReadonlyArray<Group>;
  readonly cards: ReadonlyArray<Card>;
  readonly edges: ReadonlyArray<Edge>;
}

const CARD_H = 76;

async function renderCard(card: Card, theme: Theme): Promise<string> {
  const h = card.h ?? CARD_H;
  const iconSize = 30;
  const iconX = card.x + 12;
  const iconY = card.y + (h - iconSize) / 2;
  const accent = card.accent;
  const iconBg = accent ? `${accent}26` : theme.neutralIconBg;
  const iconColor = accent ?? theme.neutralIcon;
  const nodes = await icon(card.icon);
  const glyph = nodes
    .map(([tag, attributes]) => {
      const attrs = Object.entries(attributes)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => `${key}="${value}"`)
        .join(" ");
      return `<${tag} ${attrs}/>`;
    })
    .join("");
  const lines = card.lines ?? [];
  const textX = iconX + iconSize + 12;
  const blockHeight = 17 + lines.length * 15;
  const top = card.y + (h - blockHeight) / 2 + 12;
  return `<g>
  <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${h}" rx="12" fill="${theme.card}" stroke="${theme.border}"/>
  <rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="8" fill="${iconBg}"/>
  <g transform="translate(${iconX + 7} ${iconY + 7}) scale(0.6667)" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
  <text x="${textX}" y="${top}" font-size="14" font-weight="600" fill="${theme.text}">${escapeXml(card.title)}</text>
  ${lines
    .map(
      (line, index) =>
        `<text x="${textX}" y="${top + 17 + index * 15}" font-size="12" fill="${theme.muted}">${escapeXml(line)}</text>`,
    )
    .join("\n  ")}
</g>`;
}

function renderGroup(group: Group, theme: Theme): string {
  const dot = group.accent
    ? `<circle cx="${group.x + 20}" cy="${group.y + 19}" r="3.5" fill="${group.accent}"/>`
    : "";
  const labelX = group.x + (group.accent ? 30 : 16);
  return `<g>
  <rect x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="16" fill="${theme.group}" stroke="${theme.groupBorder}" stroke-dasharray="4 4"/>
  ${dot}
  <text x="${labelX}" y="${group.y + 23}" font-size="11" font-weight="600" letter-spacing="0.06em" fill="${theme.muted}">${escapeXml(group.label.toUpperCase())}</text>
</g>`;
}

function renderEdge(edge: Edge, theme: Theme): string {
  const markers = `marker-end="url(#arrow-${theme.name})"${edge.both ? ` marker-start="url(#arrow-${theme.name})"` : ""}`;
  const path = `<path d="${edge.d}" fill="none" stroke="${theme.edge}" stroke-width="1.5"${edge.dashed ? ` stroke-dasharray="5 4"` : ""} ${markers}/>`;
  if (!edge.label || !edge.at) return path;
  const width = edge.label.length * 6.2 + 18;
  const [cx, cy] = edge.at;
  return `${path}
<rect x="${cx - width / 2}" y="${cy - 10}" width="${width}" height="20" rx="10" fill="${theme.pill}" stroke="${theme.border}"/>
<text x="${cx}" y="${cy + 4}" font-size="11" text-anchor="middle" fill="${theme.pillText}">${escapeXml(edge.label)}</text>`;
}

async function render(diagram: Diagram, theme: Theme): Promise<string> {
  const cards = await Promise.all(diagram.cards.map((card) => renderCard(card, theme)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" height="${diagram.height}" viewBox="0 0 ${diagram.width} ${diagram.height}" font-family='${FONT}' role="img" aria-label="${escapeXml(diagram.title)}">
<title>${escapeXml(diagram.title)}</title>
<defs>
  <marker id="arrow-${theme.name}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 1 1.5 L 8.5 5 L 1 8.5" fill="none" stroke="${theme.edge}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
<rect x="0.5" y="0.5" width="${diagram.width - 1}" height="${diagram.height - 1}" rx="16" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
${diagram.groups.map((group) => renderGroup(group, theme)).join("\n")}
${diagram.edges.map((edge) => renderEdge(edge, theme)).join("\n")}
${cards.join("\n")}
</svg>
`;
}

// Serving callers on top, keeping the data fresh at the bottom, R2 shared in between.
const architecture: Diagram = {
  width: 1240,
  height: 672,
  title: "Doctor directory voice agent: architecture",
  groups: [
    { x: 490, y: 42, w: 400, h: 128, label: "Agent · ElevenLabs", accent: ACCENT.voice },
    { x: 500, y: 242, w: 710, h: 128, label: "R2 · EU jurisdiction", accent: ACCENT.store },
    {
      x: 260,
      y: 442,
      w: 950,
      h: 128,
      label: "directory-sync · Cloudflare Workflow",
      accent: ACCENT.sync,
    },
  ],
  cards: [
    { x: 30, y: 78, w: 160, title: "User", lines: ["Browser today,", "phone next"], icon: "user" },
    {
      x: 250,
      y: 78,
      w: 200,
      title: "Voice service",
      lines: ["ElevenLabs · WebRTC", "speech-to-text, TTS"],
      icon: "audio-lines",
      accent: ACCENT.voice,
    },
    {
      x: 506,
      y: 78,
      w: 180,
      title: "Prompt / Skills",
      lines: ["System prompt,", "find_doctor tool"],
      icon: "sparkles",
      accent: ACCENT.voice,
    },
    {
      x: 696,
      y: 78,
      w: 180,
      title: "Context",
      lines: ["Claude Haiku 4.5,", "conversation state"],
      icon: "bot",
      accent: ACCENT.voice,
    },
    {
      x: 950,
      y: 78,
      w: 240,
      title: "doctor-lookup",
      lines: ["Worker · Effect HttpApi", "in-memory search"],
      icon: "search",
      accent: ACCENT.lookup,
    },
    {
      x: 520,
      y: 278,
      w: 250,
      title: "DB",
      lines: ["doctors.json", "the last good pull"],
      icon: "database",
      accent: ACCENT.store,
    },
    {
      x: 950,
      y: 278,
      w: 240,
      title: "Search DB",
      lines: ["search-index.json", "names, cities, specialties"],
      icon: "layers",
      accent: ACCENT.store,
    },
    {
      x: 30,
      y: 478,
      w: 170,
      title: "API",
      lines: ["Client's upstream,", "full dump ~15 min"],
      icon: "globe",
      accent: ACCENT.api,
    },
    {
      x: 30,
      y: 576,
      w: 170,
      h: 64,
      title: "Cron 03:00 UTC",
      lines: ["or Run sync now"],
      icon: "clock",
    },
    {
      x: 290,
      y: 478,
      w: 200,
      title: "1 · Pull",
      lines: ["Stage the raw dump,", "no time limit"],
      icon: "cloud-download",
      accent: ACCENT.sync,
    },
    {
      x: 520,
      y: 478,
      w: 250,
      title: "2 · Schema validation",
      lines: ["+ Deduplication,", "Effect Schema"],
      icon: "shield-check",
      accent: ACCENT.sync,
    },
    {
      x: 950,
      y: 478,
      w: 240,
      title: "3 · Data processor",
      lines: ["Build the Search DB"],
      icon: "cpu",
      accent: ACCENT.sync,
    },
  ],
  edges: [
    { d: "M 190 116 H 250", both: true, label: "WebRTC", at: [220, 64] },
    { d: "M 450 116 H 490", both: true },
    { d: "M 890 116 H 950", both: true, label: "find_doctor", at: [920, 26] },
    { d: "M 1070 154 V 278", label: "read, kept in memory", at: [1070, 216] },
    { d: "M 200 516 H 290", label: "GET /doctors", at: [245, 516] },
    { d: "M 200 608 H 240 V 540 H 290", label: "start", at: [240, 592] },
    { d: "M 490 516 H 520" },
    { d: "M 645 478 V 354", label: "save", at: [645, 416] },
    { d: "M 770 316 H 860 V 516 H 950", label: "load", at: [860, 416] },
    { d: "M 1070 478 V 354", label: "publish", at: [1070, 416] },
  ],
};

const observability: Diagram = {
  width: 1240,
  height: 268,
  title: "Doctor directory voice agent: observability",
  groups: [],
  cards: [
    {
      x: 30,
      y: 24,
      w: 220,
      h: 64,
      title: "doctor-lookup",
      lines: ["tool calls"],
      icon: "search",
      accent: ACCENT.lookup,
    },
    {
      x: 30,
      y: 102,
      w: 220,
      h: 64,
      title: "directory-sync",
      lines: ["Workflow steps"],
      icon: "cloud-download",
      accent: ACCENT.sync,
    },
    {
      x: 30,
      y: 180,
      w: 220,
      h: 64,
      title: "directory-api",
      lines: ["upstream stand-in"],
      icon: "globe",
      accent: ACCENT.api,
    },
    {
      x: 520,
      y: 96,
      w: 280,
      title: "telemetry hub",
      lines: ["Durable Object · SQLite", "live spans and logs"],
      icon: "activity",
      accent: ACCENT.telemetry,
    },
    {
      x: 930,
      y: 96,
      w: 280,
      title: "console",
      lines: ["TanStack Start on Workers", "map, traces, logs, cost"],
      icon: "monitor",
      accent: ACCENT.console,
    },
  ],
  edges: [
    { d: "M 250 56 C 390 56, 400 120, 520 122", dashed: true },
    { d: "M 250 134 H 520", dashed: true, label: "spans, logs", at: [385, 134] },
    { d: "M 250 212 C 390 212, 400 148, 520 146", dashed: true },
    { d: "M 800 134 H 930", label: "WebSocket", at: [865, 134] },
  ],
};

const out = new URL("./", import.meta.url);
for (const theme of THEMES) {
  for (const [name, diagram] of [
    ["architecture", architecture],
    ["observability", observability],
  ] as const) {
    const file = new URL(`${name}-${theme.name}.svg`, out);
    await Bun.write(file, await render(diagram, theme));
    console.log(`wrote ${file.pathname}`);
  }
}
