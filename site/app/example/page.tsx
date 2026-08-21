import type { Metadata } from "next";
import ExampleApp from "./ExampleApp";
import "./example.css";

export const metadata: Metadata = { title: "Policy example" };

export default function ExamplePage() {
  return <ExampleApp />;
}
