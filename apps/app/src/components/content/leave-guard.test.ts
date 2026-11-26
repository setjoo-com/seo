import { describe, expect, it } from "vitest";
import { inAppDestination } from "./leave-guard";

const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
const link = (href: string, target = "", download = false) => ({ href, target, hasAttribute: (name: string) => name === "download" && download });
const here = "https://app.example.com/p/1/content/drafts/2";

describe("inAppDestination", () => {
  it("holds plain clicks on links to other pages of the app", () => {
    expect(inAppDestination(click, link("https://app.example.com/p/1/content/3"), here)).toBe("/p/1/content/3");
    expect(inAppDestination(click, link("/settings?tab=key#top"), here)).toBe("/settings?tab=key#top");
  });

  it("lets through clicks that leave the app, open a new tab or stay on the page", () => {
    expect(inAppDestination(click, link("https://other.example.com/"), here)).toBeNull();
    expect(inAppDestination(click, link("/p/1", "_blank"), here)).toBeNull();
    expect(inAppDestination(click, link("/export.csv", "", true), here)).toBeNull();
    expect(inAppDestination({ ...click, metaKey: true }, link("/p/1"), here)).toBeNull();
    expect(inAppDestination({ ...click, button: 1 }, link("/p/1"), here)).toBeNull();
    expect(inAppDestination({ ...click, defaultPrevented: true }, link("/p/1"), here)).toBeNull();
    expect(inAppDestination(click, link("#terms"), here)).toBeNull();
  });
});
