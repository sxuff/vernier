import { parseArgs } from "../lib/args";
import { debugLog } from "../lib/debug";
import { VernierError } from "../lib/errors";

interface AttachConfig {
  target?: string;
  detectPorts?: number[];
}

interface ProxyOptions {
  target: URL;
  port: number | "auto";
  root: string;
}

interface AttachDependencies {
  parseProxyOptions(args: string[], config: AttachConfig): ProxyOptions;
  resolveTargetOption(args: string[], config: AttachConfig): string;
  startProxyServer(
    options: ProxyOptions,
    settings: { open: boolean },
  ): Promise<void>;
}

interface DetectedApp {
  url: string;
  label: string;
  status: number;
}

const defaultDetectPorts = [
  5173, 3000, 3001, 4173, 4200, 4321, 5000, 5174, 6006, 8000, 8080,
];

export async function detectLocalApps(
  args: string[],
  config: AttachConfig,
  dependencies: Pick<AttachDependencies, "resolveTargetOption">,
): Promise<void> {
  const parsed = parseArgs(args, { valueOptions: ["--ports"] });
  const apps = await scanLocalApps(parseDetectPorts(args, config));
  const fallbackTarget = dependencies.resolveTargetOption([], config);

  if (parsed.flag("--json")) {
    console.log(
      JSON.stringify(
        {
          appCount: apps.length,
          apps,
          suggestedAttach: apps[0]
            ? `vernier attach --target ${apps[0].url}`
            : `vernier --target ${fallbackTarget}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (apps.length === 0) {
    console.log("No local web apps found.");
    console.log(`Try: vernier --target ${fallbackTarget}`);
    return;
  }

  console.log("Found local web apps:");
  for (const app of apps) {
    console.log(`  ${app.url}  ${app.label} (${app.status})`);
  }

  console.log("");
  console.log("Attach Vernier:");
  console.log(`  vernier attach --target ${apps[0].url}`);
}

export async function attachToLocalApp(
  args: string[],
  config: AttachConfig,
  dependencies: AttachDependencies,
): Promise<void> {
  const target = await resolveAttachTarget(args, config, dependencies);
  debugLog("attach", `target=${target}`);
  const proxyArgs = [
    "--target",
    target,
    ...args.filter((arg) => arg !== "--open" && arg !== "--no-open"),
  ];
  const options = dependencies.parseProxyOptions(proxyArgs, config);

  await dependencies.startProxyServer(options, {
    open: !parseArgs(args).flag("--no-open"),
  });
}

async function resolveAttachTarget(
  args: string[],
  config: AttachConfig,
  dependencies: Pick<AttachDependencies, "resolveTargetOption">,
): Promise<string> {
  const parsed = parseArgs(args, {
    valueOptions: ["--target", "--ports", "--port"],
  });
  const explicitTarget =
    parsed.option("--target") ?? parsed.positionals().find(isUrlLike);

  if (explicitTarget) {
    return explicitTarget;
  }

  if (config.target || process.env.VERNIER_TARGET) {
    return dependencies.resolveTargetOption(args, config);
  }

  const apps = await scanLocalApps(parseDetectPorts(args, config));

  if (apps.length === 0) {
    throw new VernierError(
      "VERNIER_NO_LOCAL_APP",
      "No local web apps found.",
      `Start your app, or run: vernier attach --target ${dependencies.resolveTargetOption([], config)}`,
    );
  }

  console.log(`[vernier] detected ${apps[0].label} at ${apps[0].url}`);
  return apps[0].url;
}

async function scanLocalApps(ports: number[]): Promise<DetectedApp[]> {
  debugLog("detect", `scanning ports ${ports.join(",")}`);
  return (await Promise.all(ports.map((port) => detectPort(port)))).filter(
    (app): app is DetectedApp => Boolean(app),
  );
}

function parseDetectPorts(args: string[], config: AttachConfig): number[] {
  const portsValue = parseArgs(args, { valueOptions: ["--ports"] }).option(
    "--ports",
  );

  if (!portsValue) {
    return config.detectPorts ?? readEnvPorts() ?? defaultDetectPorts;
  }

  const ports = portsValue.split(",").map((value) => Number(value.trim()));

  if (
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid --ports value: ${portsValue}`,
      "Use a comma-separated list of TCP ports, for example --ports 5173,3000,6006.",
    );
  }

  return [...new Set(ports)];
}

function readEnvPorts(): number[] | null {
  const portsValue = process.env.VERNIER_PORTS;

  if (!portsValue) {
    return null;
  }

  const ports = portsValue.split(",").map((value) => Number(value.trim()));

  if (
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new VernierError(
      "VERNIER_INVALID_OPTION",
      `Invalid VERNIER_PORTS value: ${portsValue}`,
      "Use a comma-separated list of TCP ports, for example VERNIER_PORTS=5173,3000,6006.",
    );
  }

  return [...new Set(ports)];
}

async function detectPort(port: number): Promise<DetectedApp | null> {
  const url = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 700);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "text/html,*/*" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const server = response.headers.get("server") ?? "";
    const poweredBy = response.headers.get("x-powered-by") ?? "";
    const body =
      contentType.includes("text") || contentType.includes("html")
        ? await response.text()
        : "";

    return {
      url,
      status: response.status,
      label: classifyDetectedApp(port, body, server, poweredBy),
    };
  } catch {
    debugLog("detect", `port ${port} unavailable`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function classifyDetectedApp(
  port: number,
  body: string,
  server: string,
  poweredBy: string,
): string {
  const hints = `${body}\n${server}\n${poweredBy}`.toLowerCase();

  if (hints.includes("/@vite/client") || hints.includes("vite")) {
    return "Vite";
  }

  if (hints.includes("__next") || poweredBy.toLowerCase().includes("next")) {
    return "Next.js";
  }

  if (hints.includes("storybook") || port === 6006) {
    return "Storybook";
  }

  if (hints.includes("astro")) {
    return "Astro";
  }

  if (hints.includes("webpack")) {
    return "Webpack dev server";
  }

  return "HTTP app";
}

function isUrlLike(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
