"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "baseclf-theme";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedTheme = window.localStorage.getItem(STORAGE_KEY);
      const initialTheme: Theme = savedTheme === "dark" ? "dark" : "light";
      setTheme(initialTheme);
      applyTheme(initialTheme);
    }, 0);

    const syncTheme = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const nextTheme: Theme = event.newValue === "dark" ? "dark" : "light";
      setTheme(nextTheme);
      applyTheme(nextTheme);
    };

    window.addEventListener("storage", syncTheme);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", syncTheme);
    };
  }, []);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    applyTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
  };

  const currentLabel = theme === "light" ? "Light" : "Dark";
  const nextLabel = theme === "light" ? "Dark" : "Light";

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label={`${currentLabel} theme; switch to ${nextLabel.toLowerCase()} theme`}
      aria-pressed={theme === "dark"}
      title={`Switch to ${nextLabel} theme`}
    >
      <span className="theme-icon" aria-hidden="true">
        {theme === "light" ? "☼" : "☾"}
      </span>
      <span className="theme-label">{currentLabel}</span>
    </button>
  );
}
