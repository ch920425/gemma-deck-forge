import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = path.resolve("bin/gemma-deck-forge.mjs");
let tmpRoot = "";

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

describe("supporting CLI", () => {
  it("prints step-by-step install instructions without secret values", () => {
    const output = execFileSync(process.execPath, [cliPath, "install"], { encoding: "utf8" });
    expect(output).toContain("npm install");
    expect(output).toContain("CEREBRAS_API_KEY");
    expect(output).not.toMatch(/=csk-/);
  });

  it("runs setup doctor as JSON without exposing configured values", () => {
    const output = execFileSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: path.resolve("."),
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as { checks: Array<{ name: string; status: string; message: string }> };
    expect(parsed.checks.some((check) => check.name === "node_version" && check.status === "pass")).toBe(true);
    expect(output).not.toMatch(/=csk-/);
  });

  it("passes clean scans and fails on credential-shaped committed content", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "gemma-cli-scan-"));
    await writeFile(path.join(tmpRoot, "README.md"), "public safe content", "utf8");
    const clean = execFileSync(process.execPath, [cliPath, "scan", "--root", tmpRoot, "--json"], { encoding: "utf8" });
    expect(JSON.parse(clean).checks[0]).toMatchObject({ status: "pass" });

    await writeFile(path.join(tmpRoot, "bad.txt"), ["csk", "examplepublicleak"].join("-"), "utf8");
    expect(() => execFileSync(process.execPath, [cliPath, "scan", "--root", tmpRoot], { encoding: "utf8" })).toThrow();
  });
});
