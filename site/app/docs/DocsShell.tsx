"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import ThemeToggle from "../ThemeToggle";

const sections = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/policies", label: "Policy DSL" },
  { href: "/docs/compatibility", label: "Compatibility" },
];

export default function DocsShell({ active, children }: { active: string; children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = sections.filter((section) =>
    section.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="docs-root">
      <div className="docs-ambient" aria-hidden="true" />
      <header className="docs-topbar">
        <Link className="docs-brand" href="/" aria-label="BaseCLF home"><span className="brand-mark" aria-hidden="true"><span /></span><strong>baseclf</strong><i>docs</i></Link>
        <button className="docs-search" type="button" onClick={() => setSearchOpen(true)}><span>Search documentation</span><kbd>⌘K</kbd></button>
        <nav aria-label="Docs utilities"><a href="/studio">Open Studio</a><a href="/docs/index.md">Markdown</a><ThemeToggle /></nav>
        <button className="docs-menu-button" type="button" onClick={() => setMenuOpen((value) => !value)}>Menu</button>
      </header>

      <aside className={`docs-sidebar ${menuOpen ? "is-open" : ""}`}>
        <div><span className="docs-label">Start here</span>{sections.slice(0, 2).map((section) => <a key={section.href} className={active === section.label ? "is-current" : ""} href={section.href}>{section.label}</a>)}</div>
        <div><span className="docs-label">Reference</span>{sections.slice(2).map((section) => <a key={section.href} className={active === section.label ? "is-current" : ""} href={section.href}>{section.label}</a>)}</div>
        <div><span className="docs-label">Project</span><a href="/studio">Studio</a><a href="/llms.txt">llms.txt</a></div>
        <p><span className="docs-status-dot" /> Preview documentation</p>
      </aside>

      <article className="docs-article">{children}</article>

      <aside className="docs-toc" aria-label="On this page"><span className="docs-label">On this page</span><a href="#overview">Overview</a><a href="#details">Details</a><a href="#caveats">Caveats</a></aside>

      {searchOpen && <div className="docs-search-backdrop" role="button" tabIndex={0} aria-label="Close documentation search" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSearchOpen(false); }}><section className="docs-search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation"><input placeholder="Search docs" aria-label="Search docs" value={query} onChange={(event) => setQuery(event.target.value)} /><p>Pages</p>{matches.map((section) => <a key={section.href} href={section.href}><span>{section.label}</span><small>BaseCLF documentation</small></a>)}<footer>{matches.length === 0 ? `No pages match "${query.trim()}"` : "Static page index · Press Esc to close"}</footer></section></div>}
    </main>
  );
}
