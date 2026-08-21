import type { Metadata } from "next"; import { MigrationsApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Migrations" }; export default function Page() { return <MigrationsApp />; }
