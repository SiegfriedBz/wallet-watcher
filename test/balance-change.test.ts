import { describe, expect, it } from "vitest";
import { detectChange } from "../src/balance-change.js";

describe("detectChange", () => {
	it("first reading is 'initial', even at 0", () => {
		expect(detectChange(null, 0n)).toEqual({ type: "initial", deltaWei: 0n });
		expect(detectChange(null, 5n)).toEqual({ type: "initial", deltaWei: 5n });
	});

	it("returns null when nothing changed", () => {
		expect(detectChange(10n, 10n)).toBeNull();
	});

	it("a rise is an 'inflow' with a positive delta", () => {
		expect(detectChange(10n, 25n)).toEqual({ type: "inflow", deltaWei: 15n });
	});

	it("a drop the service did not cause is an 'external_outflow'", () => {
		expect(detectChange(25n, 10n)).toEqual({
			type: "external_outflow",
			deltaWei: -15n,
		});
	});

	it("never loses precision on large wei amounts", () => {
		const stored = 10n ** 30n;
		expect(detectChange(stored, stored + 1n)).toEqual({
			type: "inflow",
			deltaWei: 1n,
		});
	});
});
