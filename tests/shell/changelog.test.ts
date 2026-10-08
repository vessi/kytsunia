import { describe, expect, it } from "vitest";
import { changelogFor } from "../../src/shell/changelog.js";

const md = `# Changelog

Вступ.

## 0.3.0

- Третє.

## 0.2.0 (2026-10-08)

- Перше.
* Друге.

### Технічне
- Третє технічне.

## 0.1.0
`;

describe("changelogFor", () => {
  it("returns the bullet lines of the matching section only", () => {
    expect(changelogFor(md, "0.2.0")).toBe("- Перше.\n- Друге.\n- Третє технічне.");
    expect(changelogFor(md, "0.3.0")).toBe("- Третє.");
  });

  it("returns null for a missing or empty section", () => {
    expect(changelogFor(md, "0.1.0")).toBeNull();
    expect(changelogFor(md, "9.9.9")).toBeNull();
    expect(changelogFor("", "0.2.0")).toBeNull();
  });
});
