import type { Metadata } from "next";
import ExampleApp from "./ExampleApp";
import "./example.css";

export const metadata: Metadata = { title: "Policy example — BaseCLF" };

export default function ExamplePage() {
  return <ExampleApp />;
}
