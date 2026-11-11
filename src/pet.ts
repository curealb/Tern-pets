/**
 * omp desktop pet — Shinosawa Hiro (篠澤広).
 *
 * A companion sprite rendered above the editor that reacts to session/turn/tool
 * events, shows a one-line usage/balance status, and speaks via transcript
 * bubbles. Animation frames are pre-cut PNGs from the PetX V1 spritesheet.
 *
 * Rendering uses `Image` from `@oh-my-pi/pi-tui`: it emits a native image node
 * on Tern (TSP) terminals via `describe()`, and falls back to SIXEL/Kitty or a
 * text placeholder on other terminals — no per-protocol code lives here.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import {
	Image,
	Row,
	Spacer,
	Text,
	col,
	getCellDimensions,
	isNativeRendering,
	kv,
	node,
	replaceTabs,
	row,
	span,
	text,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { formatExtensionLink } from "@oh-my-pi/pi-tui/render";
import type { Component, DescribeContext, NativeNode, NativeUiEvent, RowChild, Theme, TspSpan } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Atlas (authoritative PetX V1 default animation table, rows 0..8)
// ---------------------------------------------------------------------------

const FRAME_W = 192;
const FRAME_H = 208;

interface AnimationSpec {
	name: string;
	row: number;
	frames: number;
	interval: number;
}

const ATLAS: readonly AnimationSpec[] = [
	{ name: "idle", row: 0, frames: 6, interval: 160 },
	{ name: "runningRight", row: 1, frames: 8, interval: 120 },
	{ name: "runningLeft", row: 2, frames: 8, interval: 120 },
	{ name: "waving", row: 3, frames: 4, interval: 140 },
	{ name: "jumping", row: 4, frames: 5, interval: 140 },
	{ name: "failed", row: 5, frames: 8, interval: 140 },
	{ name: "waiting", row: 6, frames: 6, interval: 150 },
	{ name: "running", row: 7, frames: 6, interval: 120 },
	{ name: "review", row: 8, frames: 6, interval: 150 },
];

const ANIM_BY_NAME = new Map<string, AnimationSpec>(ATLAS.map((a) => [a.name, a]));

// Assets sit next to this module: ../shinosawa/{frames,pet.json}.
const ASSET_DIR = path.join(import.meta.dir, "..", "shinosawa");
const FRAMES_DIR = path.join(ASSET_DIR, "frames");
const MANIFEST_PATH = path.join(ASSET_DIR, "pet.json");

const DISPLAY_NAME = "Shinosawa Hiro";
const FALLBACK_DESCRIPTION =
	"A tiny blonde chibi desktop companion based on Shinosawa Hiro, with amber eyes and a white hoodie.";

// ---------------------------------------------------------------------------
// Shared state (process-wide; the pet is decorative, so per-session memory is
// an accepted trade-off). Subagent sessions never mutate it — see the
// `ctx.agent.kind !== "main"` guards below.
// ---------------------------------------------------------------------------

let shown = true; // /shinosawa toggles
let sizePx = 96; // rendered width in px; height = sizePx * FRAME_H / FRAME_W
let forcedMood: string | null = null; // when non-null, events cannot override
let animation = "idle";
let frame = 0;
let turnFailed = false; // a tool error occurred this turn
let bubbledThisTurn = false; // at most one bubble per turn
let balanceText: string | null = null; // cached balance for the status line

// Placement + autonomous motion. Offsets are terminal cells measured from the
// widget's left edge; `Infinity` means "pin to the right edge" and is clamped
// to the live surface width on every layout.
let place: "left" | "center" | "right" | "wander" = "left";
let homeSide: "left" | "center" | "right" = "left";
let offsetCells = 0;
let walkDir = 0; // -1 left, 0 standing, 1 right
let walkTarget = 0; // destination cell for the current short leg
let nextActionAt = 0; // next autonomous walk/fidget timestamp
let usagePanelUntil = 0; // transient usage panel shown beside the pet
const WALK_STEP = 1; // cells advanced per animation tick while roaming
const WANDER_SPAN = 8; // longest single wandering leg, in cells
const WANDER_HOME_MAX = 16; // wander stays this close to the chosen home side

// Main-session runtime references (populated by the main session_start handler).
let ctxRef: ExtensionContext | null = null;
let frameTimer: Timer | null = null;
let frameTimerCtx: ExtensionContext | null = null;
let requestRender: (() => void) | null = null;
let widget: PetWidget | null = null;

// One animation cycle's worth of sprites, LRU-bounded: a repaint that did not
// advance the frame reuses its Image instead of re-encoding SIXEL, while a long
// session cannot retain every frame at every size.
const IMAGE_CACHE_LIMIT = 8;
const imageCache = new Map<string, Image>();

// ---------------------------------------------------------------------------
// Frame loading + rendering
// ---------------------------------------------------------------------------

type UsageTone = "accent" | "warning" | "error";

/** Structured usage shown beside the pet; null fields are omitted. */
interface UsagePanelData {
	usage: { tokens: number; window: number; pct: number | null } | null;
	balance: { label: string; value: string } | null;
	peak: { text: string; tone: "success" | "warning" } | null;
}

/** Quiet under 70%, warning to 90%, error above. */
function pctTone(pct: number | null): UsageTone {
	if (pct === null) return "accent";
	return pct >= 90 ? "error" : pct >= 70 ? "warning" : "accent";
}

function usageBar(pct: number, width: number): string {
	const w = Math.max(1, Math.floor(width));
	const filled = Math.max(0, Math.min(w, Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)));
	return "█".repeat(filled) + "░".repeat(w - filled);
}

/**
 * The transient usage card. Native terminals get a real TSP tree — muted
 * labels, emphasized values, a percent badge, a progress bar and a colored
 * peak/off-peak dot — while plain terminals get the same hierarchy as ANSI.
 */
class UsagePanel implements Component {
	data: UsagePanelData | null = null;
	#theme: Theme | null = null;

	setTheme(theme: Theme): void {
		this.#theme = theme;
	}

	setData(data: UsagePanelData | null): void {
		this.data = data;
	}

	render(width: number): readonly string[] {
		const data = this.data;
		const theme = this.#theme;
		if (data === null || theme === null) return [];
		const lines: string[] = [];
		if (data.usage !== null) {
			const pct = data.usage.pct;
			const tone = pctTone(pct);
			const value = `${formatTokens(data.usage.tokens)} / ${formatTokens(data.usage.window)}`;
			const badge = pct === null ? "" : ` ${theme.fg(tone, `${Math.round(pct)}%`)}`;
			lines.push(truncateToWidth(`${theme.fg("muted", "用量")} ${theme.fg("text", value)}${badge}`, width));
			if (pct !== null) lines.push(theme.fg(tone, usageBar(pct, Math.min(12, Math.max(6, width - 2)))));
		}
		if (data.balance !== null) {
			lines.push(
				truncateToWidth(
					`${theme.fg("muted", data.balance.label)} ${theme.fg("text", data.balance.value)}`,
					width,
				),
			);
		}
		if (data.peak !== null) {
			lines.push(truncateToWidth(`${theme.fg(data.peak.tone, "●")} ${theme.fg("muted", data.peak.text)}`, width));
		}
		return lines;
	}

	describe(cx: DescribeContext): NativeNode | null {
		const data = this.data;
		if (data === null) return null;
		const progress = cx.supports("progress");
		const body: NativeNode[] = [];
		if (data.usage !== null) {
			const pct = data.usage.pct;
			const tone = pctTone(pct);
			const parts: NativeNode[] = [
				text("用量", { tone: "muted" }),
				text(`${formatTokens(data.usage.tokens)} / ${formatTokens(data.usage.window)}`),
			];
			if (pct !== null) parts.push(node("badge", { text: `${Math.round(pct)}%`, tone }));
			body.push(row(parts, { gap: "sm", align: "center" }));
			if (pct !== null) {
				body.push(
					progress
						? node("progress", { value: Math.max(0, Math.min(1, pct / 100)), tone })
						: text(usageBar(pct, 12), { tone }),
				);
			}
		}
		const pairs: [string, string | TspSpan[]][] = [];
		if (data.balance !== null) pairs.push([data.balance.label, [span(data.balance.value, "text")]]);
		if (data.peak !== null) {
			pairs.push(["时段", [span("● ", data.peak.tone), span(data.peak.text, "muted")]]);
		}
		const grid = kv(pairs);
		if (grid !== undefined) body.push(grid);
		const described = col(body, { gap: "xs" });
		return described;
	}
}

class PetWidget implements Component {
	image: Image;
	imageCols: number;
	offset: number;
	panel: UsagePanelData | null = null; // transient usage block beside the pet
	panelLeft = false; // put the panel on the pet's left (pet on the right half)
	linkLabel = false; // show a clickable "用量" label (plain terminals)
	lastCols = 0; // last surface width seen, used to clamp motion
	readonly #lead = new Spacer(1);
	readonly #gap = new Spacer(1);
	readonly #tail = new Spacer(1);
	readonly #panel = new UsagePanel();
	readonly #link = new Text("", 0, 0);
	#imageIndex = 1; // slot holding the sprite in the current row
	readonly #row: Row;

	constructor(image: Image, imageCols: number, offset: number) {
		this.image = image;
		this.imageCols = Math.max(1, imageCols);
		this.offset = offset;
		this.#row = new Row({
			children: [
				{ content: this.#lead, width: 0 },
				{ content: this.image, width: this.imageCols },
				{ content: this.#tail, grow: 1 },
			],
		});
	}

	setTheme(theme: Theme): void {
		this.#panel.setTheme(theme);
	}

	/** Rebuild the horizontal layout for a surface `cols` cells wide. */
	#sync(cols: number): void {
		this.lastCols = cols;
		const off = Math.max(0, Math.min(this.offset, Math.max(0, cols - this.imageCols)));
		const panelOn = this.panel !== null;
		if (panelOn) this.#panel.setData(this.panel);
		if (this.linkLabel) {
			// Marked only in a plain terminal; Tern returns the bare label (the
			// sprite itself is clickable there through `actions.click`).
			this.#link.setText(formatExtensionLink("用量", "shinosawa:usage", "usage"));
		}
		const image: RowChild = { content: this.image, width: this.imageCols };
		const link: RowChild[] = this.linkLabel
			? [
					{ content: this.#gap, width: 1 },
					{ content: this.#link, width: 4 },
				]
			: [];
		if (!panelOn) {
			this.#imageIndex = 1;
			this.#row.setChildren([
				{ content: this.#lead, width: off },
				image,
				...link,
				{ content: this.#tail, grow: 1 },
			]);
		} else if (this.panelLeft) {
			this.#imageIndex = 2;
			this.#row.setChildren([
				{ content: this.#panel, grow: 1 },
				{ content: this.#gap, width: 1 },
				image,
				...link,
			]);
		} else {
			this.#imageIndex = 1;
			this.#row.setChildren([
				{ content: this.#lead, width: off },
				image,
				...link,
				{ content: this.#gap, width: 1 },
				{ content: this.#panel, grow: 1 },
			]);
		}
	}

	render(width: number): readonly string[] {
		this.#sync(width);
		return this.#row.render(width);
	}

	describe(cx: DescribeContext): NativeNode | null {
		this.#sync(cx.cols);
		const base = this.#row.describe(cx);
		const slot = base.c?.[this.#imageIndex];
		// An `image` clicks to zoom by default, and that default belongs to the
		// image node itself — a parent's `actions.click` cannot override it. Put
		// the usage action on the image node so the sprite opens the panel.
		if (slot === undefined || !("k" in slot) || slot.k !== "col") return base;
		const slotCol = slot as Extract<NativeNode, { k: "col" }>;
		const image = this.image.describe(cx) as Extract<NativeNode, { k: "image" }>;
		const clickable: typeof image = {
			...image,
			p: { ...image.p, actions: { ...image.p?.actions, click: "usage" } },
		};
		const children = base.c!.slice();
		children[this.#imageIndex] = { ...slotCol, c: [clickable] } as NativeNode;
		return { ...base, c: children } as NativeNode;
	}

	/** A click on the sprite (Tern native view) opens the usage panel. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "usage") showUsage();
	}
}

function readFrame(anim: string, f: number): Uint8Array {
	return readFileSync(path.join(FRAMES_DIR, `${anim}-${f}.png`));
}

function imageCellWidth(): number {
	return Math.max(1, Math.round(sizePx / getCellDimensions().widthPx));
}

function buildImage(theme: Theme): Image {
	const base64 = Buffer.from(readFrame(animation, frame)).toString("base64");
	const cell = getCellDimensions();
	const cols = imageCellWidth();
	const rows = Math.max(1, Math.round((sizePx * FRAME_H) / FRAME_W / cell.heightPx));
	return new Image(
		base64,
		"image/png",
		{ fallbackColor: (text) => theme.fg("accent", text) },
		{
			maxWidthCells: cols,
			maxHeightCells: rows,
			filename: "shinosawa",
			// When the off-thread SIXEL encode lands, repaint the widget so its
			// reserved rows are replaced by the graphic.
			requestRender: () => requestRender?.(),
		},
		{ widthPx: FRAME_W, heightPx: FRAME_H },
	);
}

/** Reuse a recent frame's Image; the LRU keeps the current cycle warm. */
function currentImage(theme: Theme): Image {
	const key = `${animation}:${frame}:${sizePx}`;
	const cached = imageCache.get(key);
	if (cached !== undefined) {
		imageCache.delete(key);
		imageCache.set(key, cached);
		return cached;
	}
	const image = buildImage(theme);
	imageCache.set(key, image);
	if (imageCache.size > IMAGE_CACHE_LIMIT) {
		const oldest = imageCache.keys().next().value;
		if (oldest !== undefined) imageCache.delete(oldest);
	}
	return image;
}

/** Re-render the widget + status line from current state. */
function repaint(): void {
	const ctx = ctxRef;
	if (!ctx || !ctx.hasUI) return;
	if (!shown) {
		ctx.ui.setWidget("shinosawa", undefined);
		return;
	}
	ctx.ui.setWidget(
		"shinosawa",
		(tui, theme) => {
			requestRender = () => tui.requestRender();
			const img = currentImage(theme);
			const cols = imageCellWidth();
			if (widget === null) widget = new PetWidget(img, cols, offsetCells);
			else {
				widget.image = img;
				widget.imageCols = cols;
				widget.offset = offsetCells;
			}
			widget.setTheme(theme);
			widget.panel = usagePanel();
			widget.linkLabel = !isNativeRendering() && ctx.ui.getLinkClicksAvailable();
			const maxOff = Math.max(0, widget.lastCols - widget.imageCols);
			const liveOff = Math.min(Number.isFinite(offsetCells) ? offsetCells : maxOff, maxOff);
			widget.panelLeft = liveOff > maxOff / 2;
			return widget;
		},
		{ placement: "aboveEditor" },
	);
	ctx.ui.setStatus("shinosawa", infoLine());
}

// ---------------------------------------------------------------------------
// Animation state machine
// ---------------------------------------------------------------------------

/** Event-driven animation switch; blocked while a mood is forced. */
function setAnimation(name: string): void {
	if (forcedMood !== null) return;
	applyAnimation(name);
}

/** Unconditional switch (used by `/shinosawa mood` to freeze a chosen frame). */
function applyAnimation(name: string): void {
	if (!ANIM_BY_NAME.has(name)) return;
	if (animation === name && frameTimer !== null) return;
	animation = name;
	frame = 0;
	if (name === "idle") nextActionAt = Date.now() + idleDelay();
	else if (name !== "runningLeft" && name !== "runningRight") walkDir = 0;
	startFrameTicker();
	repaint();
}

function intervalOf(name: string): number {
	return ANIM_BY_NAME.get(name)?.interval ?? 160;
}

/** Rightmost legal offset (cells) for the current surface width. */
function maxOffsetCells(): number {
	return Math.max(0, (widget?.lastCols ?? 0) - imageCellWidth());
}

/** Delay before the next autonomous action, tuned per placement mode. */
function idleDelay(): number {
	return place === "wander" ? 1200 + Math.random() * 2600 : 12_000 + Math.random() * 24_000;
}

/** Cells the wander mode may use, anchored to the chosen home side. */
function wanderZone(max: number): { lo: number; hi: number } {
	if (place !== "wander") return { lo: 0, hi: max };
	const span = Math.min(max, WANDER_HOME_MAX);
	if (homeSide === "right") return { lo: max - span, hi: max };
	if (homeSide === "center") {
		const center = Math.floor(max / 2);
		const half = Math.floor(span / 2);
		return { lo: Math.max(0, center - half), hi: Math.min(max, center + half) };
	}
	return { lo: 0, hi: span };
}

/** Begin a short wandering leg near the current position. */
function startWalk(now: number): void {
	const max = maxOffsetCells();
	if (max <= 0) {
		nextActionAt = now + idleDelay();
		return;
	}
	if (!Number.isFinite(offsetCells)) {
		offsetCells = place === "right" ? max : place === "left" ? 0 : Math.floor(max / 2);
	}
	const current = Math.max(0, Math.min(offsetCells, max));
	const zone = wanderZone(max);
	const lo = Math.max(zone.lo, current - WANDER_SPAN);
	const hi = Math.min(zone.hi, current + WANDER_SPAN);
	if (hi <= lo) {
		nextActionAt = now + idleDelay();
		return;
	}
	let target = lo + Math.floor(Math.random() * (hi - lo + 1));
	if (Math.abs(target - current) < 2) {
		target = target + 4 <= hi ? target + 4 : Math.max(lo, target - 4);
	}
	if (Math.abs(target - current) < 1) {
		nextActionAt = now + idleDelay();
		return;
	}
	walkTarget = target;
	walkDir = target > current ? 1 : -1;
	applyAnimation(walkDir > 0 ? "runningRight" : "runningLeft");
}

/** Stop at an edge and idle until the next leg. */
function stopWalk(now: number): void {
	walkDir = 0;
	nextActionAt = now + idleDelay();
	applyAnimation("idle");
}

/**
 * One autonomous tick. Reactions (waiting/running/failed/jumping/waving) win;
 * otherwise a roaming pet walks between edges and a pinned pet fidgets in place.
 */
function autoPilot(now: number): void {
	if (forcedMood !== null) return;
	if (animation === "runningLeft" || animation === "runningRight") {
		if (place !== "wander" || walkDir === 0) {
			stopWalk(now);
			return;
		}
		const max = maxOffsetCells();
		if (!Number.isFinite(offsetCells)) offsetCells = Math.min(walkTarget, max);
		offsetCells += walkDir * WALK_STEP;
		const reached = walkDir > 0 ? offsetCells >= walkTarget : offsetCells <= walkTarget;
		offsetCells = Math.max(0, Math.min(offsetCells, max));
		if (reached) {
			offsetCells = Math.max(0, Math.min(walkTarget, max));
			stopWalk(now);
		}
		return;
	}
	if (animation !== "idle" || now < nextActionAt) return;
	if (place === "wander") {
		startWalk(now);
		return;
	}
	nextActionAt = now + idleDelay();
	const name = Math.random() < 0.5 ? "jumping" : "waving";
	const hold = (ANIM_BY_NAME.get(name)?.frames ?? 4) * intervalOf(name) + 200;
	applyAnimation(name);
	const ctx = ctxRef;
	if (ctx) {
		ctx.setTimeout(() => {
			if (animation === name) applyAnimation("idle");
		}, hold);
	}
}

function startFrameTicker(): void {
	const ctx = ctxRef;
	if (frameTimer !== null && frameTimerCtx !== null) frameTimerCtx.clearTimer(frameTimer);
	frameTimer = null;
	frameTimerCtx = null;
	if (!ctx || !ctx.hasUI) return;
	frameTimerCtx = ctx;
	frameTimer = ctx.setInterval(() => {
		const spec = ANIM_BY_NAME.get(animation);
		if (!spec) return;
		frame = (frame + 1) % spec.frames;
		autoPilot(Date.now());
		if (shown) repaint();
	}, intervalOf(animation));
}

// ---------------------------------------------------------------------------
// Status line (usage / balance)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	const compact = (v: number, suffix: string): string => `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`;
	if (n >= 1_000_000_000) return compact(n / 1_000_000_000, "B");
	if (n >= 1_000_000) return compact(n / 1_000_000, "M");
	if (n >= 1000) return compact(n / 1000, "k");
	return String(n);
}

function fmtAmount(n: number): string {
	const r = Math.round(n * 100) / 100;
	return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

// DeepSeek peak pricing (official): Mon–Fri 01:00–04:00 and 06:00–10:00 UTC.
// Chinese public holidays are also off-peak; this approximation uses weekdays.
const PEAK_WINDOWS_UTC_MINUTES: readonly (readonly [number, number])[] = [
	[60, 240],
	[360, 600],
];

function isDeepseekPeak(date: Date): boolean {
	const day = date.getUTCDay();
	if (day === 0 || day === 6) return false;
	const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
	return PEAK_WINDOWS_UTC_MINUTES.some(([from, to]) => minute >= from && minute < to);
}

/** Milliseconds until the next peak/off-peak switch (holidays ignored). */
function nextPeakSwitch(date: Date): number {
	const start = Math.floor(date.getTime() / 60_000);
	const peak = isDeepseekPeak(date);
	for (let step = 1; step <= 3 * 24 * 60; step++) {
		if (isDeepseekPeak(new Date((start + step) * 60_000)) !== peak) {
			return (start + step) * 60_000 - date.getTime();
		}
	}
	return 0;
}

function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

/** Peak/off-peak hint; null for providers without such pricing. */
function peakValleyHint(date: Date): string | null {
	if (ctxRef?.model?.provider !== "deepseek") return null;
	const diff = formatDuration(nextPeakSwitch(date));
	return isDeepseekPeak(date) ? `峰时 · 距谷 ${diff}` : `谷时 · 半价 · 距峰 ${diff}`;
}

/** Split "label value" (e.g. "余额 52.43 CNY") without losing a label-less value. */
function splitBalance(value: string | null): { label: string; value: string } | null {
	if (value === null || value.length === 0) return null;
	const at = value.indexOf(" ");
	if (at <= 0) return { label: "余额", value };
	return { label: value.slice(0, at), value: value.slice(at + 1) };
}

/** Transient usage block shown beside the pet. */
function usagePanel(): UsagePanelData | null {
	if (Date.now() >= usagePanelUntil) return null;
	const usage = ctxRef?.getContextUsage();
	const summary =
		usage && typeof usage.tokens === "number" && typeof usage.contextWindow === "number" && usage.contextWindow > 0
			? {
					tokens: usage.tokens,
					window: usage.contextWindow,
					pct: typeof usage.percent === "number" ? usage.percent : null,
				}
			: null;
	const balance = splitBalance(balanceText);
	const now = new Date();
	const hint = peakValleyHint(now);
	const peak: UsagePanelData["peak"] =
		hint === null ? null : { text: hint, tone: isDeepseekPeak(now) ? "warning" : "success" };
	if (summary === null && balance === null && peak === null) return null;
	return { usage: summary, balance, peak };
}

function infoLine(): string {
	const ctx = ctxRef;
	const model = ctx?.models.current()?.id ?? ctx?.model?.id ?? "?";
	const usage = ctx?.getContextUsage();
	const tokens = usage && typeof usage.tokens === "number" ? formatTokens(usage.tokens) : "?";
	const window =
		usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0
			? formatTokens(usage.contextWindow)
			: null;
	const pct = usage && typeof usage.percent === "number" ? Math.round(usage.percent) : null;
	let line = `🐾 Hiro · ${window ? `${tokens}/${window}` : tokens} tok`;
	if (pct !== null) line += ` (${pct}%)`;
	if (balanceText !== null) line += ` · ${balanceText}`;
	const pv = peakValleyHint(new Date());
	if (pv !== null) line += pv.startsWith("峰时") ? " · 峰" : " · 谷";
	line += ` · ${model}`;
	return truncateToWidth(replaceTabs(line), 100);
}

/** Human-readable usage from one {@link UsageAmount}-shaped window. */
function formatUsageAmount(amount: {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	remainingFraction?: number;
	unit?: string;
}): string | null {
	const unit = amount.unit && amount.unit !== "unknown" ? amount.unit : "";
	const compact = unit === "tokens" || unit === "bytes" || unit === "credits" ? formatTokens : fmtAmount;
	if (unit === "percent") {
		const pct =
			typeof amount.used === "number"
				? amount.used
				: typeof amount.usedFraction === "number"
					? amount.usedFraction * 100
					: undefined;
		return pct === undefined ? null : `${Math.round(pct)}%`;
	}
	if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
		return `${compact(amount.used)}/${compact(amount.limit)}${unit ? ` ${unit}` : ""}`;
	}
	if (typeof amount.usedFraction === "number") return `${Math.round(amount.usedFraction * 100)}%`;
	if (typeof amount.remaining === "number") {
		return `剩 ${compact(amount.remaining)}${unit ? ` ${unit}` : ""}`;
	}
	return null;
}

/** Provider usage limits, when omp has a usage endpoint for the provider. */
async function getUsageLimitInfo(): Promise<string | null> {
	try {
		const ctx = ctxRef;
		const auth = ctx?.modelRegistry?.authStorage;
		if (!auth || typeof auth.usage?.reports !== "function") return null;
		const provider = ctx?.model?.provider;
		const reports = await auth.usage.reports(provider ? { provider } : undefined);
		if (!Array.isArray(reports) || reports.length === 0) return null;
		const report = (provider ? reports.find((entry) => entry.provider === provider) : undefined) ?? reports[0];
		const limits = report?.limits ?? [];
		const modelId = ctx?.model?.id;
		const limit =
			(modelId ? limits.find((entry) => entry.scope?.modelId === modelId) : undefined) ??
			limits.find((entry) => entry.window !== undefined) ??
			limits[0];
		const text = limit ? formatUsageAmount(limit.amount) : null;
		if (text === null) return null;
		const label = limit?.window?.label ?? limit?.label;
		return label && label.length <= 16 ? `${label}: ${text}` : text;
	} catch {
		return null;
	}
}

/**
 * DeepSeek has no usage provider in omp, so read its account balance endpoint
 * directly. Best-effort: no key, a network error, or an unexpected shape
 * degrades to null.
 */
async function getDeepseekBalance(): Promise<string | null> {
	try {
		const ctx = ctxRef;
		const auth = ctx?.modelRegistry?.authStorage;
		const provider = ctx?.model?.provider;
		if (!ctx || !auth || provider !== "deepseek") return null;
		const key = await auth.keys.get(provider, ctx.sessionManager?.getSessionId?.());
		if (!key) return null;
		const response = await fetch("https://api.deepseek.com/user/balance", {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as {
			balance_infos?: Array<{ currency?: string; total_balance?: string }>;
		};
		const info = data.balance_infos?.[0];
		if (typeof info?.total_balance !== "string" || info.total_balance.length === 0) return null;
		return `余额 ${info.total_balance} ${info.currency ?? ""}`.trim();
	} catch {
		return null;
	}
}

/** Usage limit when the provider supports it, otherwise the account balance. */
async function getBalanceInfo(): Promise<string | null> {
	return (await getUsageLimitInfo()) ?? (await getDeepseekBalance());
}

async function refreshBalance(): Promise<void> {
	const text = await getBalanceInfo();
	if (text !== balanceText) {
		balanceText = text;
		repaint();
	}
}

/** Open the usage panel immediately; refresh the balance in the background. */
function showUsage(): void {
	usagePanelUntil = Date.now() + 10_000;
	walkDir = 0;
	repaint();
	void refreshBalance();
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

class BubbleRow implements Component {
	readonly #text: string;
	readonly #theme: Theme;

	constructor(text: string, theme: Theme) {
		this.#text = text;
		this.#theme = theme;
	}

	render(width: number): readonly string[] {
		const line = truncateToWidth(replaceTabs(`🐾 Hiro · ${this.#text}`), width);
		return [this.#theme.fg("accent", line)];
	}

	isTranscriptBlockCompact(): boolean {
		return true;
	}
}

function bubbleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			if (c && typeof c === "object" && "text" in c && typeof c.text === "string") return c.text;
			return "";
		})
		.join("");
}

const ERROR_LINES = ["啊哦，这一步出错了…", "让我看看哪里不对…", "别担心，我再试一次。"];

function randomErrorLine(): string {
	return ERROR_LINES[Math.floor(Math.random() * ERROR_LINES.length)] ?? ERROR_LINES[0];
}

function bubble(pi: ExtensionAPI, text: string): void {
	if (bubbledThisTurn) return;
	bubbledThisTurn = true;
	pi.sendMessage(
		{ customType: "shinosawa-bubble", content: text, display: true, attribution: "agent" },
		{ triggerTurn: false },
	);
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function loadManifest(): { displayName?: string; description?: string } {
	try {
		return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
			displayName?: string;
			description?: string;
		};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// Plain-terminal click target: the widget draws a `shinosawa:usage` link when
	// `extensionRenderers.assistantText` is on; a click (tui.mouse) or its
	// `app.links.hint` tag raises `link_activate`. Tern routes the sprite click
	// through `PetWidget.handleNativeEvent` instead.
	pi.registerLinkScheme("shinosawa");
	pi.on("link_activate", (event) => {
		if (event.url === "shinosawa:usage") showUsage();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		ctxRef = ctx;
		turnFailed = false;
		bubbledThisTurn = false;
		setAnimation("waving");
		ctx.setTimeout(() => setAnimation("idle"), 4 * 140);
		ctx.setInterval(refreshBalance, 60_000);
		void refreshBalance();
		bubble(pi, "你好，我是 Hiro～ 今天也一起加油吧！");
	});

	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		turnFailed = false;
		bubbledThisTurn = false;
		setAnimation("waiting");
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		setAnimation("running");
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (event.isError) {
			turnFailed = true;
			setAnimation("failed");
			ctx.setTimeout(() => setAnimation("running"), 8 * 140);
			bubble(pi, randomErrorLine());
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (turnFailed) {
			setAnimation("failed");
			ctx.setTimeout(() => setAnimation("idle"), 8 * 140);
		} else {
			setAnimation("jumping");
			ctx.setTimeout(() => setAnimation("idle"), 5 * 140);
		}
		void refreshBalance();
	});

	pi.registerMessageRenderer("shinosawa-bubble", (message, _options, theme) => {
		return new BubbleRow(bubbleText(message.content), theme);
	});

	pi.registerCommand("shinosawa", {
		description: "Control the Shinosawa pet",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0];

			if (cmd === undefined) {
				shown = !shown;
				repaint();
				ctx.ui.notify(shown ? "Shinosawa 已显示" : "Shinosawa 已隐藏", "info");
				return;
			}

			switch (cmd) {
				case "show":
					shown = true;
					repaint();
					break;
				case "hide":
					shown = false;
					repaint();
					break;
				case "mood": {
					const name = parts[1];
					if (name === "auto") {
						forcedMood = null;
						applyAnimation("idle");
						ctx.ui.notify("mood 已恢复为自动", "info");
					} else if (name !== undefined && ANIM_BY_NAME.has(name)) {
						forcedMood = name;
						applyAnimation(name);
						ctx.ui.notify(`mood 已设为 ${name}`, "info");
					} else {
						ctx.ui.notify(`未知 mood: ${name ?? ""}`, "warning");
					}
					break;
				}
				case "size": {
					const n = Number.parseInt(parts[1] ?? "", 10);
					if (Number.isFinite(n)) {
						sizePx = Math.min(192, Math.max(32, n));
						repaint();
						ctx.ui.notify(`大小已设为 ${sizePx}px`, "info");
					} else {
						ctx.ui.notify("用法: /shinosawa size <32..192>", "warning");
					}
					break;
				}
				case "place": {
					const mode = parts[1];
					if (mode === "left" || mode === "center" || mode === "right" || mode === "wander") {
						place = mode;
						if (mode !== "wander") homeSide = mode;
						walkDir = 0;
						if (mode === "left") offsetCells = 0;
						else if (mode === "center") offsetCells = Math.floor(maxOffsetCells() / 2);
						else if (mode === "right") offsetCells = Number.POSITIVE_INFINITY;
						else if (!Number.isFinite(offsetCells)) offsetCells = 0;
						nextActionAt = Date.now() + (mode === "wander" ? 600 : idleDelay());
						repaint();
						ctx.ui.notify(`位置已设为 ${mode}`, "info");
					} else {
						ctx.ui.notify("用法: /shinosawa place <left|center|right|wander>", "warning");
					}
					break;
				}
				case "usage": {
					showUsage();
					break;
				}
				case "about": {
					const m = loadManifest();
					ctx.ui.notify(`${m.displayName ?? DISPLAY_NAME} — ${m.description ?? FALLBACK_DESCRIPTION}`, "info");
					break;
				}
				default:
					ctx.ui.notify(
						"用法: /shinosawa [show|hide|mood <name>|size <px>|place <left|center|right|wander>|usage|about]",
						"warning",
					);
			}
		},
	});
}
