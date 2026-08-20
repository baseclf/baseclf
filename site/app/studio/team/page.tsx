import type { Metadata } from "next"; import { TeamApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Team & Roles — BaseCLF" }; export default function Page() { return <TeamApp />; }
