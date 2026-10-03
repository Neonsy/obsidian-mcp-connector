import { describe, expect, test } from "bun:test";
import { folderPrefix, trimSlashes } from "./pathUtils";

describe("trimSlashes", () => {
  test("strips leading and trailing slashes only", () => {
    expect(trimSlashes("/a/b/")).toBe("a/b");
    expect(trimSlashes("a//")).toBe("a");
    expect(trimSlashes("a/b")).toBe("a/b");
    expect(trimSlashes("/")).toBe("");
  });
});

describe("folderPrefix", () => {
  test("a folder in any slash spelling gives one prefix", () => {
    for (const folder of ["Home", "/Home", "Home/", "/Home/"]) {
      expect(folderPrefix(folder)).toBe("Home/");
    }
  });

  test("an absent argument and the vault root mean no filter", () => {
    expect(folderPrefix(undefined)).toBeNull();
    expect(folderPrefix("/")).toBeNull();
    expect(folderPrefix("")).toBeNull();
  });
});
