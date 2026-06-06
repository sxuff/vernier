import { chromium } from "playwright";
import { createServer } from "node:http";
import { rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const targetPort = 4187;
const proxyPort = 4188;
const feedbackRoot = path.join(root, ".ui-feedback");

await rm(feedbackRoot, { recursive: true, force: true });

const targetServer = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html>
    <html>
      <head>
        <style>
          body { margin: 0; font-family: system-ui, sans-serif; }
          main { padding: 64px; }
          .card { width: 360px; height: 120px; padding: 24px; border-radius: 8px; background: #fff; color: #172033; box-sizing: border-box; border: 1px solid #d8dde8; }
          .usage-card { margin-left: 0; }
          .revenue-card { margin-top: 20px; margin-left: 12px; }
        </style>
      </head>
      <body>
        <main>
          <section class="usage-card card" data-testid="usage-card">Usage</section>
          <section class="revenue-card card" data-testid="revenue-card">Revenue</section>
        </main>
      </body>
    </html>`);
});

await listen(targetServer, targetPort);

const proxy = spawn(
  process.execPath,
  ["dist/cli.js", "proxy", "--target", `http://127.0.0.1:${targetPort}`, "--port", String(proxyPort)],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
);

try {
  await waitForOutput(proxy, "proxy listening");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: "networkidle" });
  await page.locator("[data-vernier-root]").waitFor({ state: "attached" });
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
  });

  const usage = await page.locator(".usage-card").boundingBox();
  const revenue = await page.locator(".revenue-card").boundingBox();
  if (!usage || !revenue) {
    throw new Error("Missing card bounding boxes.");
  }

  await page.mouse.move(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.locator("[data-vernier-note]").fill("align these cards");
  await page.locator("[data-vernier-add-issue]").click();
  await page.locator("[data-vernier-status]").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Added issue 1");

  await page.mouse.move(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.click(usage.x + usage.width / 2, usage.y + usage.height / 2);
  await page.mouse.move(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.mouse.click(revenue.x + revenue.width / 2, revenue.y + revenue.height / 2);
  await page.locator("[data-vernier-note]").fill("align these cards");
  await page.locator("[data-vernier-add-issue]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Added issue 2");
  await page.locator("[data-vernier-issue-id='2']").click();
  await page.locator("[data-vernier-note]").fill("edited delta note");
  await page.locator("[data-vernier-save-issue]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Saved issue 2");

  await page.locator("[data-vernier-mode]").selectOption("pen");
  await page.mouse.move(160, 160);
  await page.mouse.down();
  await page.mouse.move(220, 190);
  await page.mouse.up();
  await page.locator("[data-vernier-note]").fill("freehand annotation");
  await page.locator("[data-vernier-add-issue]").click();
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Added issue 3");

  await page.locator("[data-vernier-export]").click();
  await page.locator("[data-vernier-status]").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("[data-vernier-status]")?.textContent === "Exported");
  await browser.close();

  const sessionMarkdown = await readFile(path.join(feedbackRoot, "latest", "session.md"), "utf8");
  if (!sessionMarkdown.includes("Left edge delta: +12px")) {
    throw new Error(`Expected proxy session to contain +12px delta:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Annotation: pen")) {
    throw new Error(`Expected proxy session to contain pen annotation:\n${sessionMarkdown}`);
  }
  if (!sessionMarkdown.includes("Issue count: 3") || !sessionMarkdown.includes("edited delta note")) {
    throw new Error(`Expected cleaner edited session output:\n${sessionMarkdown}`);
  }

  console.log("proxy smoke verified");
} finally {
  proxy.kill();
  await close(targetServer);
}

function listen(server, port) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function waitForOutput(process, text) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 30_000);

    process.stdout.on("data", (chunk) => {
      if (String(chunk).includes(text)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stderr.on("data", (chunk) => {
      const message = String(chunk);
      if (message.toLowerCase().includes("error")) {
        clearTimeout(timeout);
        reject(new Error(message));
      }
    });
    process.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Proxy exited early with code ${code}`));
    });
  });
}
