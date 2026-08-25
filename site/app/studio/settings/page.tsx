import type { Metadata } from "next";
import SettingsApp from "./SettingsApp";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Project Settings", description: "The admin token, secrets, and project details of a BaseCLF deployment." };
export default function SettingsPage() { return <SettingsApp />; }
