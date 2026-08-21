import type { Metadata } from "next"; import { BackupsApp } from "../suite/SuiteApps"; import "../expansion/expansion.css";
export const metadata: Metadata = { title: "Backups & Data Transfer" }; export default function Page() { return <BackupsApp />; }
