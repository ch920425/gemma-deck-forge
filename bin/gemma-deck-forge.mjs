#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);
const root = getArg("--root") || process.cwd();

if (command === "install") {
  printInstallGuide();
} else if (command === "doctor") {
  const result = await runDoctor(root);
  printCheckResult(result);
  process.exitCode = result.checks.some((check) => check.status === "fail") ? 1 : 0;
} else if (command === "scan") {
  const result = runSecurityScan(root);
  printCheckResult(result);
  process.exitCode = result.checks.some((check) => check.status === "fail") ? 1 : 0;
} else {
  printHelp();
  process.exitCode = command === "help" || command === "--help" || command === "-h" ? 0 : 1;
}

function getArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function wantsJson() {
  return args.includes("--json");
}

function printHelp() {
  console.log(`Gemma Deck Forge CLI

Usage:
  gemma-deck-forge install          Print clone/install/run steps
  gemma-deck-forge doctor           Check local setup without printing secrets
  gemma-deck-forge scan             Scan committed files for public-release risks

Options:
  --root <path>                     Run checks against a specific checkout
  --json                            Print machine-readable check output
`);
}

function printInstallGuide() {
  const lines = [
    "# Gemma Deck Forge install guide",
    "",
    "1. Clone the repository:",
    "   git clone https://github.com/ch920425/gemma-deck-forge.git",
    "   cd gemma-deck-forge",
    "",
    "2. Install dependencies:",
    "   npm install",
    "",
    "3. Create local configuration:",
    "   cp .env.example .env",
    "   Add CEREBRAS_API_KEY to .env.",
    "",
    "4. Optional context adapters:",
    "   Set KNOWLEDGE_SUPABASE_WORKDIR and KNOWLEDGE_SUPABASE_DB_URL for Supabase-backed context.",
    "   Set LOCAL_NOTES_PATH for local Markdown context search.",
    "",
    "5. Start the app:",
    "   npm run dev -- --port 5174",
    "",
    "6. For live Figma output:",
    "   Open Figma Desktop, open a Slides file, run the Figma Desktop Bridge plugin, then use the app workflow.",
    "",
    "7. Validate the checkout:",
    "   npm run setup:check",
    "   npm run security:scan",
    "   npm run lint && npm test && npm run build"
  ];
  console.log(lines.join("\n"));
}

async function runDoctor(projectRoot) {
  const envPath = path.join(projectRoot, ".env");
  const env = readEnvFile(envPath);
  const port = Number(env.GEMMA_FIGMA_BRIDGE_PORT || process.env.GEMMA_FIGMA_BRIDGE_PORT || 9223);
  const bridgeReachable = await canConnect(port);
  const checks = [
    check("node_version", semverMajor(process.version) >= 20, `Node ${process.version}`, "Node.js 20 or newer is required."),
    check("package_json", existsSync(path.join(projectRoot, "package.json")), "package.json found", "Run from the repository root."),
    check("package_lock", existsSync(path.join(projectRoot, "package-lock.json")), "package-lock.json found", "Use npm install to restore the lockfile workflow."),
    check("dependencies", existsSync(path.join(projectRoot, "node_modules")), "node_modules found", "Run npm install before local development.", "warn"),
    check("env_file", existsSync(envPath), ".env found", "Copy .env.example to .env and add local credentials.", "warn"),
    check(
      "cerebras_key",
      Boolean(process.env.CEREBRAS_API_KEY || env.CEREBRAS_API_KEY),
      "Cerebras key configured",
      "Set CEREBRAS_API_KEY in .env for live model calls.",
      "warn"
    ),
    check("ripgrep", commandExists("rg"), "rg installed", "Install ripgrep for faster local Markdown context search.", "warn"),
    check("supabase_cli", commandExists("supabase"), "Supabase CLI installed", "Install Supabase CLI only if using the SQL context adapter.", "warn"),
    check("figma_bridge", bridgeReachable, `Figma bridge reachable on port ${port}`, "Start the app and Figma Desktop Bridge for live Figma mutations.", "warn")
  ];
  return { title: "Gemma Deck Forge setup check", checks };
}

function runSecurityScan(projectRoot) {
  const findings = [];
  for (const file of listFiles(projectRoot)) {
    const relative = path.relative(projectRoot, file);
    const text = readFileSync(file, "utf8");
    for (const pattern of publicRiskPatterns()) {
      const match = text.match(pattern.regex);
      if (match) {
        findings.push(`${relative}: ${pattern.name}`);
      }
    }
  }
  return {
    title: "Gemma Deck Forge public-release scan",
    checks: [
      check(
        "public_risk_scan",
        findings.length === 0,
        "No credential-shaped strings, private paths, or private key material found.",
        findings.slice(0, 20).join("; ") || "Review scan exclusions.",
        "fail"
      )
    ]
  };
}

function readEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const result = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    result[key] = rest.join("=").trim();
  }
  return result;
}

function check(name, ok, passMessage, failMessage, failStatus = "fail") {
  return {
    name,
    status: ok ? "pass" : failStatus,
    message: ok ? passMessage : failMessage
  };
}

function printCheckResult(result) {
  if (wantsJson()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.title);
  for (const item of result.checks) {
    const marker = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
    console.log(`${marker} ${item.name}: ${item.message}`);
  }
}

function semverMajor(version) {
  const match = version.match(/v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function commandExists(binary) {
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: 250 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function listFiles(projectRoot) {
  const excluded = new Set([
    ".git",
    ".omx",
    "coverage",
    "data",
    "dist",
    "node_modules",
    "playwright-report",
    "supabase",
    "test-results"
  ]);
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (excluded.has(entry) || entry === ".env" || entry === ".env.local") continue;
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile() && stat.size < 2_000_000) {
        files.push(full);
      }
    }
  };
  visit(projectRoot);
  return files;
}

function publicRiskPatterns() {
  return [
    { name: "private host path", regex: new RegExp("/" + "Users" + "/") },
    { name: "Cerebras API key", regex: new RegExp("csk" + "-[A-Za-z0-9]+") },
    { name: "OpenAI-style API key", regex: new RegExp("sk" + "-[A-Za-z0-9_-]+") },
    { name: "GitHub token", regex: new RegExp("gh[pousr]" + "_[A-Za-z0-9_]+") },
    { name: "private key block", regex: new RegExp("BEGIN " + "(RSA|OPENSSH|PRIVATE)") }
  ];
}
