import { annotateJsxSource } from "../dist/index.js";

const root = "C:/repo";
const id = "C:/repo/src/components/Dashboard.tsx";
const annotated = annotateJsxSource(
  `
export function Dashboard() {
  return (
    <main className="dashboard">
      <section data-vernier-source="src/manual.tsx:9">
        <button onClick={() => 2 > 1}>Save</button>
      </section>
    </main>
  );
}
`,
  id,
  { root },
);

assert(annotated, "expected JSX source annotations");
assert(
  annotated.includes(
    '<main data-vernier-source="src/components/Dashboard.tsx:4" className="dashboard">',
  ),
  "expected intrinsic tag source annotation",
);
assert(
  annotated.includes(
    '<button data-vernier-source="src/components/Dashboard.tsx:6" onClick={() => 2 > 1}>',
  ),
  "expected expression-safe tag annotation",
);
assert(
  annotated.includes('<section data-vernier-source="src/manual.tsx:9">'),
  "expected explicit source to be preserved",
);
assert(
  !annotated.includes(
    '<section data-vernier-source="src/components/Dashboard.tsx:5" data-vernier-source=',
  ),
  "expected no duplicate source attribute",
);

const unchangedComponent = annotateJsxSource(
  "export const View = () => <App />;",
  id,
  { root },
);
assert(
  unchangedComponent === null,
  "expected component-only JSX to be left untouched",
);

const ignoredDependency = annotateJsxSource(
  "export const View = () => <main />;",
  "C:/repo/node_modules/pkg/View.tsx",
  { root },
);
assert(
  ignoredDependency === null,
  "expected node_modules modules to be ignored",
);

console.log("source annotation verified");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
