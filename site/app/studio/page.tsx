import type { Metadata } from "next";
import StudioApp from "./StudioApp";
import "./studio.css";

export const metadata: Metadata = {
  title: "Studio",
  description: "Inspect policies, generated SQL, and row access in BaseCLF Studio.",
};

export default function StudioPage() {
  return <StudioApp />;
}
