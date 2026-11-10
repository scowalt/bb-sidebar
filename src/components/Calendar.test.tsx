// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Calendar } from "./Calendar";

afterEach(cleanup);

describe("Calendar", () => {
  it("keeps six weeks when moving between months of different lengths", () => {
    // February 2027 starts on a Monday and fills exactly four Monday-first weeks; March 2027 needs five.
    render(<Calendar weekStartsOn={1} defaultMonth={new Date(2027, 1, 1)} />);
    const weekCount = () => screen.getAllByRole("row").length;

    expect(weekCount()).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(weekCount()).toBe(6);
  });
});
