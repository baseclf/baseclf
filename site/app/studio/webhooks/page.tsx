import type { Metadata } from "next"; import { WebhooksApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Webhooks & Queues" }; export default function Page() { return <WebhooksApp />; }
