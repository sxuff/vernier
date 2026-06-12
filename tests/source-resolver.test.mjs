import { resolveSource, sourceResolvers } from "../dist/index.js";

const child = fakeElement({
  attributes: {},
  parentElement: fakeElement({
    attributes: {
      "data-vernier-source": "src/components/Card.tsx:42",
      "data-vernier-component": "MetricCard",
      "data-vernier-owner-chain": "DashboardPage > MetricsGrid > MetricCard"
    }
  })
});

const annotated = resolveSource(child);
assert(annotated.resolver === "data-vernier-source", "expected source attribute resolver to win");
assert(annotated.source === "src/components/Card.tsx:42", "expected annotated file source");
assert(annotated.componentName === "MetricCard", "expected annotated component name");
assert(annotated.ownerChain.join(">") === "DashboardPage>MetricsGrid>MetricCard", "expected annotated owner chain");

const componentOnly = resolveSource(fakeElement({
  attributes: {
    "data-vernier-component": "ServerRenderedButton"
  }
}));
assert(componentOnly.resolver === "data-vernier-component", "expected component attribute resolver");
assert(componentOnly.source === "unresolved", "component-only annotations should not fake a file source");
assert(componentOnly.sourceConfidence === undefined, "source resolution should use confidence, not legacy fields");
assert(componentOnly.confidence === "medium", "component-only annotations should carry medium confidence");

function CheckoutButton() {}
const reactElement = fakeElement({
  fiber: {
    type: CheckoutButton,
    _debugSource: {
      fileName: "C:/repo/src/components/CheckoutButton.tsx",
      lineNumber: 12
    }
  }
});
const reactSource = resolveSource(reactElement);
assert(reactSource.resolver === "react-debug-source", "expected React debug source resolver");
assert(reactSource.source === "src/components/CheckoutButton.tsx:12", "expected trimmed React source path");
assert(reactSource.componentName === "CheckoutButton", "expected React component name");

assert(sourceResolvers.map((resolver) => resolver.name).join(",") === "data-vernier-source,react-debug-source,data-vernier-component,react-component-name", "expected stable resolver order");

console.log("source resolver verified");

function fakeElement({ attributes = {}, parentElement = null, fiber = null }) {
  const element = {
    parentElement,
    getAttribute(name) {
      return attributes[name] ?? null;
    }
  };

  if (fiber) {
    element.__reactFiber$test = fiber;
  }

  return element;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
