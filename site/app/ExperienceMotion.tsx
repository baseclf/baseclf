"use client";

import { useEffect } from "react";

export default function ExperienceMotion() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    document.documentElement.classList.add("experience-motion");
    const activate = (root: ParentNode = document) => {
      root.querySelectorAll<HTMLElement>(".expansion-dialog, .confirm-dialog, .command-palette, .state-gallery, .studio-toast, .expansion-toast").forEach((item) => item.classList.add("motion-pop"));
    };
    activate();

    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          if (node.matches(".expansion-dialog, .confirm-dialog, .command-palette, .state-gallery, .studio-toast, .expansion-toast")) node.classList.add("motion-pop");
          activate(node);
        }
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const onPointerDown = (event: PointerEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button, a");
      target?.classList.add("is-pressing");
    };
    const clearPressed = () => document.querySelectorAll(".is-pressing").forEach((item) => item.classList.remove("is-pressing"));
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", clearPressed);
    document.addEventListener("pointercancel", clearPressed);

    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", clearPressed);
      document.removeEventListener("pointercancel", clearPressed);
      document.documentElement.classList.remove("experience-motion");
    };
  }, []);

  return null;
}
