import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="dashboard">
      <section className="hero">
        <p className="eyebrow">Vernier dogfood app</p>
        <h1>Revenue dashboard</h1>
      </section>

      <section className="cards" aria-label="Dashboard metrics">
        <article className="usage-card card" data-testid="usage-card">
          <p className="card-label">Usage</p>
          <strong>84%</strong>
          <span>Capacity used this month</span>
        </article>

        <article className="revenue-card card" data-testid="revenue-card">
          <p className="card-label">Revenue</p>
          <strong>$128k</strong>
          <span>Trailing 30 days</span>
        </article>
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
