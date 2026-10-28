import { describe, expect, it } from "vitest";
import { folderLabel } from "./folderLabel";

describe("a folder as a person reads it", () => {
  it("is from the profile, under it", () => {
    expect(folderLabel("%USERPROFILE%\\Videos\\Razorcat")).toBe("Videos\\Razorcat");
    expect(folderLabel("%userprofile%\\Desktop")).toBe("Desktop");
  });

  it("is as it is, elsewhere", () => {
    expect(folderLabel("D:\\Exports")).toBe("D:\\Exports");
    expect(folderLabel("%OneDrive%\\Videos")).toBe("%OneDrive%\\Videos");
  });
});
