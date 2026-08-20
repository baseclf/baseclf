import type { Metadata } from "next"; import { RealtimeApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Realtime Concept — BaseCLF" }; export default function Page() { return <RealtimeApp />; }
