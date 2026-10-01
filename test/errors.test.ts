import { HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../src/shared/errors.js";

// A provider URL with the API key in the path, like Alchemy's.
const URL_WITH_KEY = "https://eth-sepolia.g.alchemy.com/v2/SECRET-KEY-123";

describe("safeErrorMessage", () => {
	it("never contains the RPC URL or its key (viem errors)", () => {
		const error = new HttpRequestError({ url: URL_WITH_KEY, status: 503 });

		expect(error.message).toContain("SECRET-KEY-123"); // the leak we avoid
		expect(safeErrorMessage(error)).not.toContain("SECRET-KEY-123");
		expect(safeErrorMessage(error)).toBe("HTTP request failed.");
	});

	it("returns the message of a normal error", () => {
		expect(safeErrorMessage(new Error("boom"))).toBe("boom");
	});

	it("handles non-Error values", () => {
		expect(safeErrorMessage("oops")).toBe("oops");
	});
});
