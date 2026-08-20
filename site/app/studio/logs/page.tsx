import type { Metadata } from "next";
import LogsApp from "./LogsApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Request Logs — BaseCLF", description: "Inspect mock request and policy traces in BaseCLF." };
export default function LogsPage() { return <LogsApp />; }
