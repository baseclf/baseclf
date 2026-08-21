import type { Metadata } from "next"; import { UsageApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Usage & Billing" }; export default function Page() { return <UsageApp />; }
