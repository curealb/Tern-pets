import { afterEach, beforeEach, expect, test } from "bun:test";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import type { Component, DescribeContext, Image, Theme, TUI } from "@oh-my-pi/pi-tui";
import pet from "../src/pet";

type Widget = Component & { image: Image };
type WidgetFactory = (tui: Pick<TUI, "imageBudget" | "requestRender">, theme: Theme) => Widget;

// Exercise the extension through its public command/widget registration. The
// renderer, layout, Image and ImageBudget are the real OMP implementations.
function harness() {
	let command: (args: string, context: unknown) => Promise<void>;
	let widget: Widget | undefined;
	let tick: (() => void) | undefined;
	const budget = new ImageBudget(8);
	const tui = { imageBudget: budget, requestRender() {} };
	const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
	const context = {
		agent: { kind: "main" },
		hasUI: true,
		getContextUsage: () => undefined,
		setInterval(callback: () => void) {
			tick = callback;
			return 1;
		},
		clearTimer() {},
		ui: {
			setWidget(_name: string, factory: WidgetFactory | undefined) {
				widget = factory?.(tui, theme);
			},
			setStatus() {},
			getLinkClicksAvailable: () => false,
			notify() {},
		},
	};
	pet({
		registerLinkScheme() {},
		on() {},
		registerMessageRenderer() {},
		registerCommand(_name: string, definition: { handler: typeof command }) {
			command = definition.handler;
		},
	} as unknown as Parameters<typeof pet>[0]);
	return {
		budget,
		command: (args: string) => command(args, context),
		widget: () => widget,
		tick: () => tick?.(),
		paint(width = 80) {
			budget.beginPass();
			const lines = widget?.render(width) ?? [];
			expect(budget.endPass()).toBe(false);
			budget.limitResidentImages();
			return { lines: lines.join("\n"), transmits: budget.takeTransmits(), purges: budget.takePurgeIds() };
		},
	};
}

const originalProtocol = TERMINAL.imageProtocol;
const originalGraphics = { ...getKittyGraphics() };
const originalCells = { ...getCellDimensions() };
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
let host: ReturnType<typeof harness>;

beforeEach(async () => {
	terminal.imageProtocol = ImageProtocol.Kitty;
	setKittyGraphics({ unicodePlaceholders: false });
	setCellDimensions({ widthPx: 8, heightPx: 16 });
	host = harness();
	await host.command("hide");
	await host.command("show");
	await host.command("mood waving");
	await host.command("mood idle");
});

afterEach(async () => {
	await host.command("hide");
	terminal.imageProtocol = originalProtocol;
	setKittyGraphics(originalGraphics);
	setCellDimensions(originalCells);
});

test("repaints and moves one identified placement instead of uploading anonymous images", async () => {
	const first = host.paint();
	const id = host.widget()!.image.debugState().imageId;
	expect(id).toBeNumber();
	expect(first.transmits).toHaveLength(1);
	expect(first.lines).toContain(`i=${id},p=${id}`);
	expect(first.lines).not.toContain("\x1b_Ga=T");
	await host.command("place right");
	const moved = host.paint();
	expect(moved.transmits).toHaveLength(0);
	expect(moved.lines).toContain(`i=${id},p=${id}`);
	expect(moved.lines).not.toBe(first.lines);
});

test("purges the previous animation frame, including when the image cap is disabled", async () => {
	host.budget.setCap(0);
	host.paint();
	let previous = host.widget()!.image.debugState().imageId;
	for (const mood of ["waving", "jumping", "idle", "running", "idle"]) {
		await host.command(`mood ${mood}`);
		const next = host.paint();
		const id = host.widget()!.image.debugState().imageId;
		expect(id).toBeNumber();
		expect(id).not.toBe(previous);
		expect(next.purges).toContain(previous);
		expect(next.transmits).toHaveLength(1);
		previous = id;
	}
});

test("hiding the widget purges its current image and showing it transmits again", async () => {
	host.paint();
	const id = host.widget()!.image.debugState().imageId;
	await host.command("hide");
	const hidden = host.paint();
	expect(hidden.lines).toBe("");
	expect(hidden.purges).toContain(id);
	await host.command("show");
	expect(host.paint().transmits).toHaveLength(1);
});

test("uses placeholder cells when enabled and respects disabled image output", () => {
	setKittyGraphics({ unicodePlaceholders: true });
	const placeholders = host.paint();
	expect(placeholders.lines).toContain("\u{10eeee}");
	expect(placeholders.lines).toContain("a=p,U=1");
	terminal.imageProtocol = null;
	const disabled = host.paint();
	expect(disabled.lines).not.toContain("\x1b_G");
	expect(disabled.lines).toContain("[Image:");
});

test("a new TUI receives fresh image ownership rather than cached images from the previous budget", async () => {
	host.paint();
	await host.command("hide");
	host.paint();
	host = harness();
	await host.command("show");
	const first = host.paint();
	expect(first.transmits).toHaveLength(1);
	expect(host.widget()!.image.debugState().imageId).toBeNumber();
});

test("cycling all animations leaves one resident image after hundreds of ticks", async () => {
	host.budget.setCap(0);
	host.paint();
	let previous = host.widget()!.image.debugState().imageId;
	for (const mood of ["idle", "runningRight", "runningLeft", "waving", "jumping", "failed", "waiting", "running", "review"]) {
		await host.command(`mood ${mood}`);
		for (let frame = 0; frame < 32; frame++) {
			host.tick();
			const next = host.paint();
			const id = host.widget()!.image.debugState().imageId;
			expect(next.purges).toContain(previous);
			expect(next.transmits).toHaveLength(1);
			previous = id;
		}
	}
	expect(host.budget.takeAllTransmittedIds()).toEqual([previous]);
});

test("host disposal retires the graphic and native image descriptions remain clickable", () => {
	host.paint();
	const widget = host.widget()!;
	const id = widget.image.debugState().imageId;
	const native = widget.describe!({ cols: 80 } as DescribeContext);
	expect(native?.k).toBe("row");
	const slot = native?.c?.[1];
	expect(slot && "k" in slot && slot.k).toBe("col");
	const image = slot && "c" in slot ? slot.c?.[0] : undefined;
	expect(image && "k" in image && image.k).toBe("image");
	expect(image && "p" in image && image.p?.actions?.click).toBe("usage");
	widget.dispose?.();
	host.budget.beginPass();
	host.budget.endPass();
	host.budget.limitResidentImages();
	expect(host.budget.takePurgeIds()).toContain(id);
});
