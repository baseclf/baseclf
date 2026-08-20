"use client";

import { useEffect } from "react";

export default function MotionEffects() {
  useEffect(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const revealItems = Array.from(
      document.querySelectorAll<HTMLElement>(".reveal, [data-stagger]"),
    );

    document.body.classList.add("motion-ready");

    revealItems.forEach((item) => {
      Array.from(item.children).forEach((child, index) => {
        if (child instanceof HTMLElement) {
          child.style.setProperty("--reveal-delay", `${Math.min(index * 72, 288)}ms`);
        }
      });
    });

    if (reducedMotion.matches) {
      revealItems.forEach((item) => item.classList.add("is-visible"));
      root.style.setProperty("--page-progress", "1");
      return () => document.body.classList.remove("motion-ready");
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          } else {
            entry.target.classList.remove("is-visible");
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -5% 0px" },
    );

    revealItems.forEach((item) => observer.observe(item));

    const parallaxItems = window.matchMedia("(min-width: 901px)").matches
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-parallax]"))
      : [];
    let frame = 0;

    const updateScrollEffects = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const progress = scrollable > 0 ? window.scrollY / scrollable : 0;
      const parallaxMeasurements = parallaxItems.map((item) => {
        const rect = item.getBoundingClientRect();
        const centerOffset = rect.top + rect.height / 2 - window.innerHeight / 2;
        const movement = Math.max(-18, Math.min(18, centerOffset * -0.022));
        return { item, movement };
      });

      root.style.setProperty("--page-progress", String(Math.min(1, Math.max(0, progress))));
      parallaxMeasurements.forEach(({ item, movement }) => {
        item.style.setProperty("--parallax-y", `${movement.toFixed(2)}px`);
      });
      frame = 0;
    };

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateScrollEffects);
    };

    const spotlightItems = Array.from(
      document.querySelectorAll<HTMLElement>("[data-spotlight]"),
    );
    const spotlightListeners = spotlightItems.map((item) => {
      const move = (event: PointerEvent) => {
        const rect = item.getBoundingClientRect();
        item.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
        item.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
      };
      item.addEventListener("pointermove", move);
      return { item, move };
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      spotlightListeners.forEach(({ item, move }) => {
        item.removeEventListener("pointermove", move);
      });
      document.body.classList.remove("motion-ready");
    };
  }, []);

  return <div className="scroll-progress" aria-hidden="true" />;
}
