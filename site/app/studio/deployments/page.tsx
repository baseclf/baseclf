import type { Metadata } from "next"; import { DeploymentsApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Deployments" }; export default function Page() { return <DeploymentsApp />; }
