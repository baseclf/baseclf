import type { Metadata } from "next";
import ApiExplorerApp from "./ApiExplorerApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "API Explorer", description: "Build and inspect protected BaseCLF API requests." };
export default function ApiExplorerPage() { return <ApiExplorerApp />; }
