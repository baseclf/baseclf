import type { Metadata } from "next"; import { ApiKeysApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "API Keys — BaseCLF" }; export default function Page() { return <ApiKeysApp />; }
