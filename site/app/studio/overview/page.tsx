import type { Metadata } from "next";
import "../expansion/expansion.css";
import OverviewApp from "./OverviewApp";

export const metadata: Metadata = { title: "Project overview — BaseCLF", description: "See what is ready and what to do next in BaseCLF." };

export default function OverviewPage() {
  return <OverviewApp />;
}
